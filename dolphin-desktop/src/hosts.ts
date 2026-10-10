/* Where a window's agents run: this computer, or a machine reached over SSH.
 *
 * Either way the Dolphin helper serves on a private Unix socket on that
 * machine, and the app reaches it through a loopback relay:
 *   local:  a net.Server on 127.0.0.1 that pipes each connection to the socket
 *   SSH:    `ssh -N -L 127.0.0.1:<port>:<remote socket>`
 * so there is one helper mode, SSH is the remote login, and the helper's token
 * keeps other local processes off the relay port. */

import { ChildProcess, execFile, spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { passwordPrompts } from './askpass';

// The helper an SSH host runs is the one this app ships: same version number.
// dolphin-backend/tests/test_helper_mode.py keeps app/version.py in step.
export const HELPER_VERSION: string = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version;

export type HostSpec = { kind: 'local' } | { kind: 'ssh'; target: string };
export type LinkState = 'connected' | 'reconnecting' | 'offline';
export type Connection = {
  apiBase: string; token: string; label: string; close: () => void;
  /** SSH only: hear the link drop and come back. `tokenChanged` means the page must reload. */
  watch?: (listener: (state: LinkState, info: { reason?: string; tokenChanged?: boolean }) => void) => void;
  /** SSH only: try again now (after sleep, or the Reconnect button, which may ask for a password). */
  reconnectNow?: (interactive: boolean) => void;
  /** SSH only: this connection needed a password, so passwordless sign-in is worth offering. */
  usedPassword?: boolean;
};

const READY_TIMEOUT_MS = 45_000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** How to run the helper on this machine: the bundled binary when packaged,
 *  the repository's venv during development. */
export function localHelperCommand(resourcesPath: string | undefined, appRoot: string): { command: string; args: string[]; cwd?: string } {
  const bundled = path.join(helperDir(resourcesPath, appRoot), `${process.platform}-${process.arch}`, 'dolphin-helper', 'dolphin-helper');
  if ((resourcesPath || process.env.DOLPHIN_DESKTOP_USE_BUNDLE) && existsSync(bundled)) return { command: bundled, args: [] };
  const backend = path.resolve(appRoot, '..', 'dolphin-backend');
  return { command: path.join(backend, 'venv', 'bin', 'python'), args: ['-m', 'app.helper'], cwd: backend };
}

function run(command: string, args: string[], options: { cwd?: string; input?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { cwd: options.cwd, env: options.env ?? process.env, timeout: options.timeout ?? 120_000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => (error ? reject(new Error((stderr || error.message).trim())) : resolve(stdout)));
    if (options.input !== undefined) child.stdin?.end(options.input);
  });
}

/** A loopback TCP port that pipes every connection to a Unix socket. */
function relay(socketPath: string): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve, reject) => {
    // Track every piped pair: server.close() alone waits for open keep-alive
    // and streaming connections, which kept the app from quitting.
    const open = new Set<net.Socket>();
    const server = net.createServer((client) => {
      const upstream = net.connect(socketPath);
      open.add(client);
      open.add(upstream);
      client.pipe(upstream).pipe(client);
      const end = () => {
        client.destroy();
        upstream.destroy();
        open.delete(client);
        open.delete(upstream);
      };
      client.on('close', end);
      upstream.on('close', end);
      client.on('error', end);
      upstream.on('error', end);
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as net.AddressInfo;
      resolve({
        port: address.port,
        close: () => {
          server.close();
          for (const socket of open) socket.destroy();
          open.clear();
        },
      });
    });
  });
}

async function waitHealthy(apiBase: string, timeout = READY_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeout;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${apiBase}/health`);
      if (response.ok) return;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = String(error);
    }
    await sleep(250);
  }
  throw new Error(`Dolphin's helper did not answer (${last}).`);
}

/** Start (or reuse) the helper on this computer. */
export async function connectLocal(resourcesPath: string | undefined, appRoot: string): Promise<Connection> {
  const home = process.env.DOLPHIN_HOME || path.join(os.homedir(), '.dolphin-server');
  const helper = localHelperCommand(resourcesPath, appRoot);
  const out = await run(helper.command, [...helper.args, 'serve', '--detach'], { cwd: helper.cwd, env: { ...process.env, DOLPHIN_HOME: home } });
  let info: { socket?: string } = {};
  for (let attempt = 0; attempt < 120 && !info.socket; attempt += 1) {
    try {
      info = JSON.parse(readFileSync(path.join(home, 'run', 'server.json'), 'utf8'));
    } catch {
      info = out.trim() ? safeJson(out) : {};
      if (!info.socket) await sleep(250);
    }
  }
  if (!info.socket) throw new Error("Dolphin's helper did not start. See ~/.dolphin-server/logs/helper.log.");
  for (let attempt = 0; attempt < 120 && !existsSync(info.socket); attempt += 1) await sleep(250);
  const token = readFileSync(path.join(home, 'token'), 'utf8').trim();
  const local = await relay(info.socket);
  const apiBase = `http://127.0.0.1:${local.port}`;
  await waitHealthy(apiBase);
  return { apiBase, token, label: os.hostname(), close: local.close };
}

function safeJson(text: string): { socket?: string } {
  try {
    return JSON.parse(text.trim().split('\n').pop() || '{}');
  } catch {
    return {};
  }
}

/* --- SSH ------------------------------------------------------------------ */

// Set by the main process: SSH_ASKPASS and friends, so ssh's prompts become dialogs.
let sshEnv: NodeJS.ProcessEnv = {};
export function setSshEnv(env: NodeJS.ProcessEnv): void {
  sshEnv = env;
}

function controlPath(): string {
  const dir = path.join(os.homedir(), '.dolphin-desktop', 'ssh');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, '%C');
}

/** Dolphin's own SSH key, made only when the user sets up passwordless sign-in.
 *  It lives beside Dolphin's other files; the user's ~/.ssh is never changed. */
export function dolphinKey(): string {
  return path.join(os.homedir(), '.dolphin-desktop', 'ssh', 'id_ed25519');
}

function sshArgs(target: string, extra: string[] = []): string[] {
  return [
    // Tests only, and first because ssh keeps the first value of each option:
    // e.g. a scratch UserKnownHostsFile so the real one is never touched.
    ...(process.env.DOLPHIN_DESKTOP_SSH_OPTIONS ? process.env.DOLPHIN_DESKTOP_SSH_OPTIONS.split(' ') : []),
    '-o', 'ConnectTimeout=20',
    '-o', 'NumberOfPasswordPrompts=3',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    // Added to the user's own keys, never instead of them.
    ...(existsSync(dolphinKey()) ? ['-o', `IdentityFile=${dolphinKey()}`] : []),
    '-o', 'ControlMaster=auto',
    '-o', `ControlPath=${controlPath()}`,
    '-o', 'ControlPersist=10m',
    ...extra,
    '--',
    target,
  ];
}

export function ssh(target: string, script: string, input?: string, extra: string[] = []): Promise<string> {
  return run('ssh', [...sshArgs(target, extra), 'sh', '-c', shellQuote(script)], { input, timeout: 300_000, env: { ...process.env, ...sshEnv } });
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Hosts the user already named in ~/.ssh/config, for the Connect list. */
export function sshConfigHosts(): string[] {
  try {
    const text = readFileSync(path.join(os.homedir(), '.ssh', 'config'), 'utf8');
    const hosts = new Set<string>();
    for (const line of text.split('\n')) {
      const match = /^\s*Host\s+(.+)$/i.exec(line);
      if (match) for (const name of match[1].split(/\s+/)) if (name && !/[*?!]/.test(name)) hosts.add(name);
    }
    return [...hosts].sort();
  } catch {
    return [];
  }
}

/** Where helper bundles live: inside the packaged app, or helper-bundles/ in a checkout. */
export function helperDir(resourcesPath: string | undefined, appRoot: string): string {
  return resourcesPath ? path.join(resourcesPath, 'helper') : path.join(appRoot, 'helper-bundles');
}

/** The helper bundle for a remote's `uname -sm`, if this app carries one. */
export function remoteBundle(bundles: string, uname: string): string | null {
  const [kernel, machine] = uname.trim().split(/\s+/);
  const platform = kernel === 'Darwin' ? 'darwin' : 'linux';
  const arch = /^(aarch64|arm64)$/.test(machine) ? 'arm64' : 'x64';
  const candidate = path.join(bundles, `${platform}-${arch}.tar.xz`);
  return existsSync(candidate) ? candidate : null;
}

/** Extra settings for the remote helper, for tests only (e.g. DOLPHIN_GBRAIN=off).
 *  NAME=value pairs separated by spaces; anything else is ignored. */
function remoteEnv(): string {
  const pairs = (process.env.DOLPHIN_DESKTOP_REMOTE_ENV || '').split(' ').filter((pair) => /^[A-Z][A-Z0-9_]*=[A-Za-z0-9_.:/-]*$/.test(pair));
  return pairs.map((pair) => `; export ${pair}`).join('');
}

/** Connect to a machine over SSH: install the helper if needed, start it, and
 *  forward a loopback port to its socket. */
export async function connectSsh(target: string, bundles: string, onStatus: (text: string) => void): Promise<Connection> {
  // The remote helper's home. Tests point it at a scratch folder.
  const home = process.env.DOLPHIN_DESKTOP_REMOTE_HOME || '$HOME/.dolphin-server';
  onStatus(`Connecting to ${target}…`);
  const promptsBefore = passwordPrompts();
  const probe = await ssh(target, `uname -sm; printf '%s\\n' "$HOME"; test -x "${home}/versions/${HELPER_VERSION}/dolphin-helper/dolphin-helper" && echo installed || echo missing`);
  const [uname, remoteHome, state] = probe.trim().split('\n');
  const devCommand = process.env.DOLPHIN_DESKTOP_DEV_REMOTE_HELPER; // dev only: run a helper from a checkout on the remote
  let helper = `"${home}/versions/${HELPER_VERSION}/dolphin-helper/dolphin-helper"`;
  if (devCommand) {
    helper = devCommand;
  } else if (state !== 'installed') {
    const bundle = remoteBundle(bundles, uname);
    if (!bundle) throw new Error(`Dolphin has no helper for ${uname.trim()} yet.`);
    onStatus(`Setting up Dolphin on ${target}…`);
    await new Promise<void>((resolve, reject) => {
      const child = spawn('ssh', [...sshArgs(target), 'sh', '-c', shellQuote(`set -e; d="${home}/versions/${HELPER_VERSION}"; rm -rf "$d.part"; mkdir -p "$d.part"; tar -xJ -C "$d.part"; rm -rf "$d"; mv "$d.part" "$d"`)], { stdio: ['pipe', 'ignore', 'pipe'], env: { ...process.env, ...sshEnv } });
      let stderr = '';
      child.stderr.on('data', (chunk) => (stderr += chunk));
      createReadStream(bundle).pipe(child.stdin);
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(stderr.trim() || `upload failed (${code})`))));
    });
  }
  onStatus(`Starting Dolphin on ${target}…`);
  const startScript = `export DOLPHIN_HOME="${home}"${remoteEnv()}; ${helper} serve --detach >/dev/null 2>&1; for i in $(seq 1 120); do test -S "$(sed -n 's/.*"socket": "\\([^"]*\\)".*/\\1/p' "$DOLPHIN_HOME/run/server.json" 2>/dev/null)" && break; sleep 0.25; done; cat "$DOLPHIN_HOME/run/server.json"; printf '\\n'; cat "$DOLPHIN_HOME/token"`;
  // Starts the helper if it is not running (after a reboot, say) and says where it listens.
  const start = async (extra: string[] = []) => {
    const [serverJson, token] = (await ssh(target, startScript, undefined, extra)).trim().split('\n');
    const info = safeJson(serverJson);
    if (!info.socket || !token) throw new Error(`Dolphin could not start on ${target}.`);
    return { socket: info.socket, token: token.trim() };
  };
  let remote = await start();
  void remoteHome;
  const usedPassword = passwordPrompts() > promptsBefore;

  // The forward keeps one loopback port for the window's whole life, so the
  // page's address never changes; only the SSH connection behind it is replaced.
  // With connection sharing (ControlMaster), `ssh -N -L` hands the forward to
  // the shared connection and exits 0 at once, so its exit says nothing about
  // the link: a health check every 10 seconds does, and a non-zero exit (no
  // sharing, or the forward was refused) counts as a drop.
  const port = await freePort();
  const apiBase = `http://127.0.0.1:${port}`;
  let tunnel: ChildProcess | null = null;
  let closed = false;
  let recovering = false;
  let wake: (() => void) | null = null;
  let interactive = false;
  let listener: (state: LinkState, info: { reason?: string; tokenChanged?: boolean }) => void = () => undefined;
  const openTunnel = (extra: string[] = []) => {
    const child = spawn('ssh', [...sshArgs(target, [...extra, '-N', '-o', 'ExitOnForwardFailure=yes', '-o', 'StreamLocalBindUnlink=yes', '-L', `127.0.0.1:${port}:${remote.socket}`])], { stdio: 'ignore', env: { ...process.env, ...sshEnv } });
    tunnel = child;
    child.once('exit', (code) => { if (tunnel === child && !closed && code !== 0) void recover(); });
  };

  /* The link dropped (network change, sleep, the machine rebooted): try again
     with growing pauses, without prompting. A password-only machine can't come
     back by itself, so it waits for the Reconnect button, which may ask. */
  const recover = async () => {
    if (recovering || closed) return;
    recovering = true;
    listener('reconnecting', {});
    for (let attempt = 0; !closed; attempt += 1) {
      const batch = interactive ? [] : ['-o', 'BatchMode=yes'];
      interactive = false;
      try {
        const before = remote.token;
        remote = await start(batch);
        openTunnel(batch);
        await waitHealthy(apiBase, 20_000);
        recovering = false;
        listener('connected', { tokenChanged: remote.token !== before });
        return;
      } catch (error) {
        const old = tunnel;
        tunnel = null;
        old?.kill();
        const reason = error instanceof Error ? error.message : String(error);
        if (/permission denied|authentication|password/i.test(reason)) {
          listener('offline', { reason: 'Sign-in is needed to reconnect.' });
          await new Promise<void>((resolve) => { wake = resolve; });
          continue;
        }
        listener('reconnecting', { reason });
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5)));
          wake = () => { clearTimeout(timer); resolve(); };
        });
      }
    }
  };

  openTunnel();
  try {
    await waitHealthy(apiBase);
  } catch (error) {
    closed = true;
    (tunnel as ChildProcess | null)?.kill();
    throw error;
  }
  let misses = 0;
  const check = async () => {
    if (closed || recovering) return;
    try {
      const response = await fetch(`${apiBase}/health`, { signal: AbortSignal.timeout(5_000) });
      misses = response.ok ? 0 : misses + 1;
    } catch {
      misses += 1;
    }
    if (misses >= 2 && !closed && !recovering) {
      misses = 0;
      void recover();
    }
  };
  const watchdog = setInterval(() => void check(), 10_000);
  return {
    apiBase,
    get token() { return remote.token; },
    label: target,
    usedPassword,
    close: () => {
      closed = true;
      clearInterval(watchdog);
      (tunnel as ChildProcess | null)?.kill();
      wake?.();
      // The shared SSH connection holds the forward itself; give the port back now
      // rather than when that connection lapses.
      spawn('ssh', [...sshArgs(target, ['-O', 'cancel', '-L', `127.0.0.1:${port}:${remote.socket}`])], { stdio: 'ignore', env: { ...process.env, ...sshEnv } }).on('error', () => undefined);
    },
    watch: (next) => { listener = next; },
    reconnectNow: (asked) => {
      if (closed) return;
      if (asked) interactive = true;
      if (recovering) { const resume = wake; wake = null; resume?.(); }
      else if (asked) void recover();
      else { misses = 1; void check(); } // after sleep: one failed check is enough
    },
  };
}

/** Passwordless sign-in: make Dolphin's own key if needed and add it to the
 *  machine's authorized_keys, over the connection that is already signed in. */
export async function installKey(target: string): Promise<void> {
  const key = dolphinKey();
  if (!existsSync(key)) {
    mkdirSync(path.dirname(key), { recursive: true, mode: 0o700 });
    await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', `dolphin-desktop@${os.hostname()}`, '-f', key]);
  }
  const publicKey = readFileSync(`${key}.pub`, 'utf8').trim();
  await ssh(target, 'umask 077; mkdir -p "$HOME/.ssh"; touch "$HOME/.ssh/authorized_keys"; read -r key; grep -qxF "$key" "$HOME/.ssh/authorized_keys" || printf "%s\\n" "$key" >> "$HOME/.ssh/authorized_keys"', `${publicKey}\n`);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}
