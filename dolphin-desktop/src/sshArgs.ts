/* The ssh options every Dolphin connection uses, apart from hosts.ts so they
 * can be tested without Electron (test/agent-forwarding.test.mjs). */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** One socket per machine, named from the target alone. ssh's own %C also
 *  hashes this computer's hostname, which macOS changes with the network; a
 *  new name loses the running master, whose forward then holds the link's
 *  port, so every reconnect failed to forward and started over. */
export function controlPath(target: string): string {
  const dir = path.join(os.homedir(), '.dolphin-desktop', 'ssh');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, createHash('sha1').update(target).digest('hex').slice(0, 24));
}

/** Dolphin's own SSH key, made only when the user sets up passwordless sign-in.
 *  It lives beside Dolphin's other files; the user's ~/.ssh is never changed. */
export function dolphinKey(): string {
  return path.join(os.homedir(), '.dolphin-desktop', 'ssh', 'id_ed25519');
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** `shared`: through the machine's ControlMaster (every command but the agent
 *  keeper). Unshared connections turn connection sharing off explicitly, and
 *  first, so neither a ControlMaster in the user's own ssh_config nor a test's
 *  ControlPath can hand them to the shared connection. Shared connections
 *  never forward the agent: only the keeper does, and only when it is on. */
export function sshArgs(target: string, extra: string[] = [], shared = true): string[] {
  return [
    ...(shared ? [] : ['-o', 'ControlMaster=no', '-o', 'ControlPath=none']),
    // Tests only, and before the rest because ssh keeps the first value of each
    // option: e.g. a scratch UserKnownHostsFile so the real one is never touched.
    ...(process.env.DOLPHIN_DESKTOP_SSH_OPTIONS ? process.env.DOLPHIN_DESKTOP_SSH_OPTIONS.split(' ') : []),
    '-o', 'ConnectTimeout=20',
    '-o', 'NumberOfPasswordPrompts=3',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    // Added to the user's own keys, never instead of them.
    ...(existsSync(dolphinKey()) ? ['-o', `IdentityFile=${dolphinKey()}`] : []),
    ...(shared
      ? ['-o', 'ForwardAgent=no', '-o', 'ControlMaster=auto', '-o', `ControlPath=${controlPath(target)}`, '-o', 'ControlPersist=10m']
      : []),
    ...extra,
    '--',
    target,
  ];
}

/** Runs on the machine for as long as agent forwarding is on: points the
 *  helper's stable agent link (<DOLPHIN_HOME>/run/agent.sock, which the
 *  helper's tmux_service hands new sessions as SSH_AUTH_SOCK) at this
 *  connection's forwarded agent, then holds the connection, and so the agent,
 *  open. It waits on its stdin, a pipe from this computer, so it ends when the
 *  connection does: there is no pty, so a `sleep` would get no SIGHUP and
 *  outlive every disconnect. */
export function agentKeeperScript(home: string): string {
  return `test -S "$SSH_AUTH_SOCK" || { echo "No SSH agent reached the machine. Check that one runs on this computer (ssh-add -l)." >&2; exit 3; }; `
    // A new link beside the old one, renamed over it: rename(2) is atomic, so a
    // session starting meanwhile finds the old link or the new one, never none.
    // Plain `mv -f` (GNU's -T is not everywhere); the target is a link to a socket, not a folder.
    + `mkdir -p "${home}/run" && ln -sfn "$SSH_AUTH_SOCK" "${home}/run/.agent.sock.$$" && mv -f "${home}/run/.agent.sock.$$" "${home}/run/agent.sock" && echo ready && exec cat >/dev/null`;
}

/** Its own connection (agent forwarding is decided per connection, and the
 *  shared ControlMaster started without it); BatchMode, because nothing should
 *  ask for a password in the background. */
export function agentKeeperArgs(target: string, home: string): string[] {
  return [...sshArgs(target, ['-o', 'ForwardAgent=yes', '-o', 'BatchMode=yes'], false), 'sh', '-c', shellQuote(agentKeeperScript(home))];
}
