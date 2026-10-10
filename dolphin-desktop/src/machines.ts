/* Which machines the user could connect to, found without asking them.
 *
 * Connect to a Machine lists, in this order:
 * - recent:    machines Dolphin connected to before (machines.json in the profile)
 * - config:    Host entries in ~/.ssh/config, following Include
 * - history:   `ssh …` commands in the shell history, most used first
 * - tailscale: the tailnet's Mac and Linux devices, with whether they are
 *              online and whether Tailscale SSH is on
 * - known:     unhashed names in ~/.ssh/known_hosts
 * Everything is read locally and nothing is contacted until the user picks one.
 * This module has no Electron imports, so its parsers are tested directly. */

import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type MachineSource = 'recent' | 'config' | 'history' | 'tailscale' | 'known';
export type Machine = { target: string; label: string; detail?: string; source: MachineSource; online?: boolean; lastUsed?: number };

/** What ssh accepts as a destination from Dolphin: a name, user@host, or ssh://user@host:port. Never an option. */
export function validTarget(target: string): boolean {
  return /^(ssh:\/\/)?[A-Za-z0-9._@:-]{1,253}$/.test(target) && !/^-/.test(target.replace(/^ssh:\/\//, ''));
}

const LOCAL = /^(localhost|127\.\d+\.\d+\.\d+|::1|0\.0\.0\.0)$/i;
const hostOf = (target: string) => target.replace(/^ssh:\/\//, '').replace(/^[^@]*@/, '').replace(/:\d+$/, '');
const isLocal = (target: string) => LOCAL.test(hostOf(target)) || hostOf(target).toLowerCase() === os.hostname().toLowerCase();

/* --- ~/.ssh/config ----------------------------------------------------------- */

/** Host entries with a usable name, and the user@hostname they stand for. */
export function parseSshConfig(text: string, include: (pattern: string) => string[] = () => [], depth = 0): Machine[] {
  const found = new Map<string, { user?: string; hostName?: string }>();
  let current: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*/, '').trim();
    const match = /^(\S+)\s*=?\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, value] = match;
    switch (key.toLowerCase()) {
      case 'host':
        current = value.split(/\s+/).filter((name) => name && !/[*?!]/.test(name));
        for (const name of current) if (!found.has(name)) found.set(name, {});
        break;
      case 'match':
        current = [];
        break;
      case 'hostname':
        for (const name of current) found.get(name)!.hostName ??= value;
        break;
      case 'user':
        for (const name of current) found.get(name)!.user ??= value;
        break;
      case 'include':
        if (depth < 3) {
          for (const file of value.split(/\s+/).flatMap(include)) {
            for (const machine of parseSshConfig(file, include, depth + 1)) {
              if (!found.has(machine.target)) found.set(machine.target, { hostName: machine.detail });
            }
          }
        }
        break;
    }
  }
  return [...found].map(([name, info]) => ({
    target: name,
    label: name,
    detail: info.hostName ? `${info.user ? `${info.user}@` : ''}${info.hostName}` : info.user ? `${info.user}@${name}` : undefined,
    source: 'config' as const,
  }));
}

/** The text of the files an Include names, relative to ~/.ssh, with * in the file name. */
function includeFiles(sshDir: string) {
  return (pattern: string): string[] => {
    const full = path.isAbsolute(pattern) ? pattern : path.join(sshDir, pattern.replace(/^~\//, `${os.homedir()}/`));
    const dir = path.dirname(full);
    const base = path.basename(full);
    const names = base.includes('*') ? (() => {
      try {
        const re = new RegExp(`^${base.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
        return readdirSync(dir).filter((name) => re.test(name)).sort();
      } catch { return []; }
    })() : [base];
    return names.flatMap((name) => { try { return [readFileSync(path.join(dir, name), 'utf8')]; } catch { return []; } });
  };
}

/* --- shell history ------------------------------------------------------------ */

// ssh options that take a value, from ssh(1).
const WITH_VALUE = new Set('BbcDEeFIiJLlmOoPpQRSWw'.split(''));

/** Destinations of `ssh` commands in a bash or zsh history, most used first. */
export function parseHistory(text: string): Machine[] {
  const counts = new Map<string, { count: number; last: number }>();
  const lines = text.split('\n');
  lines.forEach((raw, index) => {
    const line = raw.replace(/^: \d+:\d+;/, ''); // zsh extended history
    for (const command of line.split(/&&|\|\||;|\|/)) {
      const words = command.trim().split(/\s+/);
      if (words[0] !== 'ssh') continue;
      let user = '';
      let port = '';
      let destination = '';
      for (let i = 1; i < words.length && !destination; i += 1) {
        const word = words[i];
        if (word === '--') { destination = words[i + 1] ?? ''; break; }
        if (word.startsWith('-') && word.length > 1) {
          const flag = word[1];
          if (WITH_VALUE.has(flag)) {
            const value = word.length > 2 ? word.slice(2) : words[++i] ?? '';
            if (flag === 'l') user = value;
            if (flag === 'p') port = value;
          }
          continue;
        }
        destination = word;
      }
      if (!destination || !/^[A-Za-z0-9._@-]+$/.test(destination)) continue;
      const withUser = user && !destination.includes('@') ? `${user}@${destination}` : destination;
      const target = /^\d+$/.test(port) && port !== '22' ? `ssh://${withUser}:${port}` : withUser;
      if (!validTarget(target) || isLocal(target)) continue;
      const seen = counts.get(target) ?? { count: 0, last: 0 };
      counts.set(target, { count: seen.count + 1, last: index });
    }
  });
  return [...counts]
    .sort((a, b) => b[1].count - a[1].count || b[1].last - a[1].last)
    .slice(0, 8)
    .map(([target, { count }]) => ({ target, label: hostOf(target), detail: `${target.replace(/^ssh:\/\//, '')} · used ${count} time${count === 1 ? '' : 's'}`, source: 'history' as const }));
}

/* --- known_hosts --------------------------------------------------------------- */

/** Names in known_hosts that are not hashed and use the standard port. */
export function parseKnownHosts(text: string): Machine[] {
  const names = new Set<string>();
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#') || line.startsWith('|') || line.startsWith('@')) continue;
    for (const name of line.split(/\s+/)[0].split(',')) {
      if (name && !name.startsWith('[') && validTarget(name) && !isLocal(name)) names.add(name);
    }
  }
  return [...names].slice(0, 12).map((name) => ({ target: name, label: name, source: 'known' as const }));
}

/* --- recent machines ------------------------------------------------------------- */

type Recents = { recent: { target: string; lastUsed: number }[] };

function readRecents(dataDir: string): Recents {
  try {
    const value = JSON.parse(readFileSync(path.join(dataDir, 'machines.json'), 'utf8')) as Recents;
    return { recent: (value.recent ?? []).filter((item) => typeof item.target === 'string' && validTarget(item.target)) };
  } catch {
    return { recent: [] };
  }
}

/** Remember a machine Dolphin connected to; the latest comes first. */
export function rememberMachine(dataDir: string, target: string): void {
  const recents = readRecents(dataDir);
  recents.recent = [{ target, lastUsed: Date.now() }, ...recents.recent.filter((item) => item.target !== target)].slice(0, 12);
  try { writeFileSync(path.join(dataDir, 'machines.json'), JSON.stringify(recents, null, 2)); } catch { /* remembering is a convenience */ }
}

export function forgetMachine(dataDir: string, target: string): void {
  const recents = readRecents(dataDir);
  recents.recent = recents.recent.filter((item) => item.target !== target);
  try { writeFileSync(path.join(dataDir, 'machines.json'), JSON.stringify(recents, null, 2)); } catch { /* as above */ }
}

/* --- Tailscale ------------------------------------------------------------------- */

type TailscalePeer = { HostName?: string; DNSName?: string; OS?: string; Online?: boolean; TailscaleIPs?: string[]; sshHostKeys?: string[] };
type TailscaleStatus = { Peer?: Record<string, TailscalePeer>; CurrentTailnet?: { MagicDNSEnabled?: boolean } | null };

/** The tailnet's Mac and Linux devices; phones, Windows and Funnel relays can't
 *  run the helper. Reached by MagicDNS name, or by Tailscale IP when MagicDNS
 *  is off. Online ones first. */
export function parseTailscale(status: TailscaleStatus): Machine[] {
  const magicDns = status.CurrentTailnet?.MagicDNSEnabled !== false;
  return Object.values(status.Peer ?? {})
    .filter((peer) => (peer.OS === 'linux' || peer.OS === 'macOS') && peer.HostName !== 'funnel-ingress-node')
    .map((peer) => {
      const name = peer.DNSName?.replace(/\.$/, '') ?? '';
      const ip = peer.TailscaleIPs?.find((address) => address.includes('.')) ?? peer.TailscaleIPs?.[0] ?? '';
      const target = magicDns && name ? name : ip;
      const facts = [peer.OS === 'macOS' ? 'Mac' : 'Linux', peer.sshHostKeys?.length ? 'Tailscale SSH' : '', peer.Online ? '' : 'offline'];
      return {
        target,
        label: peer.HostName || name.split('.')[0] || ip,
        detail: [target, ...facts].filter(Boolean).join(' · '),
        source: 'tailscale' as const,
        online: Boolean(peer.Online),
      };
    })
    .filter((machine) => machine.target && validTarget(machine.target))
    .sort((a, b) => Number(b.online) - Number(a.online) || a.label.localeCompare(b.label));
}

/** `tailscale status --json`, wherever the CLI is: on PATH, or where the Mac
 *  app and Homebrew put it (an app opened from the Dock has a short PATH). */
function tailscale(): Promise<Machine[]> {
  const candidates = ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale'];
  return new Promise((resolve) => {
    const next = (index: number) => {
      if (index >= candidates.length) return resolve([]);
      execFile(candidates[index], ['status', '--json'], { timeout: 2500, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
        if (error) return next(index + 1);
        try { resolve(parseTailscale(JSON.parse(stdout))); } catch { resolve([]); }
      });
    };
    next(0);
  });
}

/* --- all together ------------------------------------------------------------------ */

const read = (file: string) => { try { return readFileSync(file, 'utf8'); } catch { return ''; } };

/** Every machine Dolphin can suggest, each once, in source order. */
export async function detectMachines(dataDir: string, home = os.homedir()): Promise<Machine[]> {
  const sshDir = path.join(home, '.ssh');
  const tailnet = tailscale();
  const histories = ['.zsh_history', '.bash_history'].map((name) => path.join(home, name)).filter(existsSync);
  const config = parseSshConfig(read(path.join(sshDir, 'config')), includeFiles(sshDir));
  const all: Machine[] = [
    ...readRecents(dataDir).recent.map((item) => ({ target: item.target, label: hostOf(item.target), detail: item.target.replace(/^ssh:\/\//, ''), source: 'recent' as const, lastUsed: item.lastUsed })),
    ...config,
    ...parseHistory(histories.map(read).join('\n')),
    ...(await tailnet),
    ...parseKnownHosts(read(path.join(sshDir, 'known_hosts'))),
  ];
  const seen = new Set<string>();
  const online = new Map(all.filter((item) => item.source === 'tailscale').map((item) => [item.target.toLowerCase(), item.online]));
  return all.filter((item) => {
    const key = item.target.toLowerCase();
    if (seen.has(key) || isLocal(item.target)) return false;
    seen.add(key);
    return true;
  }).map((item) => (item.online === undefined && online.has(item.target.toLowerCase()) ? { ...item, online: online.get(item.target.toLowerCase()) } : item));
}
