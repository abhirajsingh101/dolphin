/* Where a window's agents run: this computer, or a machine reached over SSH.
 *
 * Either way the Dolphin helper serves on a private Unix socket on that
 * machine, and the app reaches it through a loopback relay:
 *   local:  a net.Server on 127.0.0.1 that pipes each connection to the socket
 *   SSH:    `ssh -N -L 127.0.0.1:<port>:<remote socket>`
 * so there is one helper mode, SSH is the remote login, and the helper's token
 * keeps other local processes off the relay port. */

import { ChildProcess, execFile, spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { passwordPrompts } from './askpass';
import { formatProgress, installScript, pruneScript, sha256File } from './remote-install';
import { classifyRemote, LIBC_PROBE, remoteLogScript, startFailureMessage } from './remote';
import { healthOnce, waitHealthy } from './health';
import { pidAlive, readServerInfo, waitForServer } from './local-helper';
import { TunnelSlot } from './tunnel';
import { Forwards, cancelArgs, forwardArgs, freeLocalPort, heldForwardArgs, holdForward } from './forwards';
import { createRecovery, createWatchdog } from './watchdog';
import { agentKeeperArgs, dolphinKey, shellQuote, sshArgs } from './sshArgs';
import { createAgentKeeper } from './agent-keeper';

export { dolphinKey } from './sshArgs';

// The helper an SSH host runs is the one this app ships: same version number.
// dolphin-backend/tests/test_helper_mode.py keeps app/version.py in step.
export const HELPER_VERSION: string = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version;

export type HostSpec = { kind: 'local' } | { kind: 'ssh'; target: string };
export type LinkState = 'connected' | 'reconnecting' | 'offline';
export type Connection = {
  apiBase: string; token: string; label: string; close: () => void;
  /** Hear the link drop and come back. `tokenChanged` means the page must reload. */
  watch?: (listener: (state: LinkState, info: { reason?: string; tokenChanged?: boolean }) => void) => void;
  /** Try again now (after sleep, a network change, or Reconnect; SSH may then ask for a password). */
  reconnectNow?: (interactive: boolean) => void;
  /** SSH only: this connection needed a password, so passwordless sign-in is worth offering. */
  usedPassword?: boolean;
  /** SSH only: the local port that reaches `remote` on the machine (forwards.ts). */
  forwardPort?: (remote: number) => Promise<number>;
  /** SSH only: keep the machine's run/agent.sock pointed at this computer's SSH agent, or stop. */
  setAgentForwarding?: (on: boolean) => Promise<{ ok?: true; error?: string }>;
  /** SSH only: hear forwarding that was on break by itself (an error) or come back (undefined). */
  watchAgent?: (listener: (error: string | undefined) => void) => void;
};

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
function relay(socketPath: () => string): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve, reject) => {
    // Track every piped pair: server.close() alone waits for open keep-alive
    // and streaming connections, which kept the app from quitting.
    const open = new Set<net.Socket>();
    const server = net.createServer((client) => {
      const upstream = net.connect(socketPath());
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

/** How often this computer's helper is checked: /health over the local relay is cheap. */
const LOCAL_CHECK_MS = 2_000;
/** Failed restarts in a row before this computer shows as offline and waits for Reconnect. */
const LOCAL_GIVE_UP_AFTER = 5;

/** Start (or reuse) the helper on this computer, and keep it running: a
 *  helper that dies is started again behind the same relay port. */
export async function connectLocal(resourcesPath: string | undefined, appRoot: string): Promise<Connection> {
  const home = process.env.DOLPHIN_HOME || path.join(os.homedir(), '.dolphin-server');
  const helper = localHelperCommand(resourcesPath, appRoot);
  const helperEnv = { ...process.env, DOLPHIN_HOME: home };
  const readToken = () => readFileSync(path.join(home, 'token'), 'utf8').trim();
  const start = async () => {
    const before = readServerInfo(home);
    await run(helper.command, [...helper.args, 'serve', '--detach'], { cwd: helper.cwd, env: helperEnv });
    const { socket, pid } = await waitForServer(home, before, { timeoutMs: 45_000 });
    return { socket, pid, token: readToken() };
  };
  let current = await start();
  const local = await relay(() => current.socket);
  const apiBase = `http://127.0.0.1:${local.port}`;
  try {
    await waitHealthy(apiBase);
  } catch (error) {
    local.close();
    throw error;
  }
  let closed = false;
  let listener: (state: LinkState, info: { reason?: string; tokenChanged?: boolean }) => void = () => undefined;
  const recovery = createRecovery({
    attempt: async (n) => {
      // `serve` reuses a helper that is alive. One that is alive but still not
      // answering after a full try is hung: stop it so `serve` starts afresh.
      if (n > 0 && readServerInfo(home)?.pid === current.pid && pidAlive(current.pid)) {
        await run(helper.command, [...helper.args, 'stop'], { cwd: helper.cwd, env: helperEnv, timeout: 30_000 }).catch(() => undefined);
      }
      const before = current.token;
      current = await start();
      await waitHealthy(apiBase, 20_000);
      return { tokenChanged: current.token !== before };
    },
    onState: (state, info) => { if (!closed) listener(state, info); },
    delayMs: (n) => Math.min(15_000, 1_000 * 2 ** Math.min(n, 4)),
    giveUpAfter: LOCAL_GIVE_UP_AFTER,
    closed: () => closed,
  });
  const watchdog = createWatchdog({
    check: () => healthOnce(apiBase, 2_000), intervalMs: LOCAL_CHECK_MS, misses: 2,
    paused: () => closed || recovery.active, onDrop: () => void recovery.run(),
  });
  return {
    apiBase,
    get token() { return current.token; },
    label: os.hostname(),
    close: () => { closed = true; watchdog.stop(); recovery.wake(); local.close(); },
    watch: (next) => { listener = next; },
    // While offline (given up), recovery waits and the watchdog stays paused
    // until Reconnect or a wake from sleep. There is no sign-in here, so
    // `interactive` makes no difference to this computer's helper.
    reconnectNow: () => {
      if (closed) return;
      if (recovery.active) recovery.wake(); else watchdog.checkNow(1); // after sleep: one failed check is enough
    },
  };
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

export function ssh(target: string, script: string, input?: string, extra: string[] = [], timeout = 300_000): Promise<string> {
  return run('ssh', [...sshArgs(target, extra), 'sh', '-c', shellQuote(script)], { input, timeout, env: { ...process.env, ...sshEnv } });
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

/** Extra settings for the remote helper, for tests only (e.g. DOLPHIN_GBRAIN=off).
 *  NAME=value pairs separated by spaces; anything else is ignored. */
function remoteEnv(): string {
  const pairs = (process.env.DOLPHIN_DESKTOP_REMOTE_ENV || '').split(' ').filter((pair) => /^[A-Z][A-Z0-9_]*=[A-Za-z0-9_.:/-]*$/.test(pair));
  return pairs.map((pair) => `; export ${pair}`).join('');
}

/** Send the helper bundle to `target`, saying how far along it is. */
async function uploadHelper(target: string, bundle: string, home: string, onStatus: (text: string) => void): Promise<void> {
  const total = statSync(bundle).size;
  const sha = await sha256File(bundle);
  onStatus(`Uploading Dolphin to ${target}… ${formatProgress(0, total)}`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn('ssh', [...sshArgs(target), 'sh', '-c', shellQuote(installScript(home, HELPER_VERSION, sha))], { stdio: ['pipe', 'ignore', 'pipe'], env: { ...process.env, ...sshEnv } });
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const source = createReadStream(bundle);
    let sent = 0;
    let shown = 0;
    source.on('data', (chunk) => {
      sent += chunk.length;
      if (Date.now() - shown >= 250) {
        shown = Date.now();
        onStatus(`Uploading Dolphin to ${target}… ${formatProgress(sent, total)}`);
      }
    });
    source.on('end', () => onStatus(`Setting up Dolphin on ${target}…`));
    // The remote end closing early (disk full) breaks the pipe; its stderr says why.
    child.stdin.on('error', () => undefined);
    source.pipe(child.stdin);
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(stderr.trim() || `upload failed (${code})`))));
  });
}

/** The remote helper's home. Tests point it at a scratch folder. */
export const remoteHelperHome = () => process.env.DOLPHIN_DESKTOP_REMOTE_HOME || '$HOME/.dolphin-server';

/** The end of `target`'s helper log, over the shared SSH connection. */
export function fetchRemoteLog(target: string, lines = 200): Promise<string> {
  return ssh(target, remoteLogScript(remoteHelperHome(), lines), undefined, [], 15_000);
}

/** Connect to a machine over SSH: install the helper if needed, start it, and
 *  forward a loopback port to its socket. */
export async function connectSsh(target: string, bundles: string, onStatus: (text: string) => void): Promise<Connection> {
  const home = remoteHelperHome();
  onStatus(`Connecting to ${target}…`);
  const promptsBefore = passwordPrompts();
  const probe = await ssh(target, `uname -sm; printf '%s\\n' "$HOME"; test -x "${home}/versions/${HELPER_VERSION}/dolphin-helper/dolphin-helper" && echo installed || echo missing; ${LIBC_PROBE}`);
  const [uname = '', remoteHome, state, libc = 'glibc'] = probe.trim().split('\n');
  const devCommand = process.env.DOLPHIN_DESKTOP_DEV_REMOTE_HELPER; // dev only: run a helper from a checkout on the remote
  let helper = `"${home}/versions/${HELPER_VERSION}/dolphin-helper/dolphin-helper"`;
  if (devCommand) {
    helper = devCommand;
  } else if (state !== 'installed') {
    const platform = classifyRemote(target, uname, libc);
    if (!platform.ok) throw new Error(platform.message);
    const bundle = path.join(bundles, `${platform.key}.tar.xz`);
    if (!existsSync(bundle)) throw new Error(`This copy of Dolphin carries no helper for ${platform.key}.`);
    await uploadHelper(target, bundle, home, onStatus);
  }
  onStatus(`Starting Dolphin on ${target}…`);
  const startScript = `export DOLPHIN_HOME="${home}"${remoteEnv()}; ${helper} serve --detach >/dev/null 2>&1; for i in $(seq 1 120); do test -S "$(sed -n 's/.*"socket": "\\([^"]*\\)".*/\\1/p' "$DOLPHIN_HOME/run/server.json" 2>/dev/null)" && break; sleep 0.25; done; cat "$DOLPHIN_HOME/run/server.json"; printf '\\n'; cat "$DOLPHIN_HOME/token"`;
  // Starts the helper if it is not running (after a reboot, say) and says where it listens.
  const start = async (extra: string[] = []) => {
    const [serverJson, token] = (await ssh(target, startScript, undefined, extra)).trim().split('\n');
    const info = safeJson(serverJson);
    if (!info.socket || !token) {
      const tail = await ssh(target, remoteLogScript(home, 20), undefined, extra, 15_000).catch(() => '');
      throw new Error(startFailureMessage(target, tail));
    }
    return { socket: info.socket, token: token.trim() };
  };
  let remote = await start();
  // Keep this version and the one before it; older ones only take space.
  if (!devCommand) void ssh(target, pruneScript(home, HELPER_VERSION)).catch(() => undefined);
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
  const tunnels = new TunnelSlot<ChildProcess>();
  let closed = false;
  let recovering = false;
  let wake: (() => void) | null = null;
  let interactive = false;
  let listener: (state: LinkState, info: { reason?: string; tokenChanged?: boolean }) => void = () => undefined;
  const openTunnel = (extra: string[] = []) => {
    const child = tunnels.replace(() => spawn('ssh', [...sshArgs(target, [...extra, '-N', '-o', 'ExitOnForwardFailure=yes', '-o', 'StreamLocalBindUnlink=yes', '-L', `127.0.0.1:${port}:${remote.socket}`])], { stdio: 'ignore', env: { ...process.env, ...sshEnv } }));
    child.once('exit', (code) => { if (tunnels.isCurrent(child) && !closed && code !== 0) void recover(); });
  };
  /** Give the loopback port back to this machine: the shared connection
   *  (ControlMaster) holds the forward itself, keyed by the socket it went to. */
  const cancelForward = (socket: string) => new Promise<void>((resolve) => {
    const child = spawn('ssh', [...sshArgs(target, ['-O', 'cancel', '-L', `127.0.0.1:${port}:${socket}`])], { stdio: 'ignore', env: { ...process.env, ...sshEnv } });
    const timer = setTimeout(resolve, 3_000);
    child.on('exit', () => { clearTimeout(timer); resolve(); });
    child.on('error', () => { clearTimeout(timer); resolve(); });
  });

  // Ports on the machine opened on this computer: held by the shared
  // connection (`ssh -O forward`), or by an ssh of our own when there is no
  // shared connection to hand them to (ControlMaster off). Both bind
  // 127.0.0.1 here and reach the machine's own 127.0.0.1.
  const held = new Map<number, TunnelSlot<ChildProcess>>();
  const disconnected = () => new Error(`${target} is disconnected.`);
  const forwards = new Forwards({
    freePort: freeLocalPort,
    add: async (local, remote) => {
      try {
        await run('ssh', sshArgs(target, forwardArgs(local, remote)), { env: { ...process.env, ...sshEnv }, timeout: 20_000 });
      } catch {
        const slot = held.get(local) ?? new TunnelSlot<ChildProcess>();
        await slot.kill();
        if (closed) throw disconnected();
        // holdForward refuses a port someone else took and an ssh that gave up;
        // one that gives up later marks the forward lost, so Open makes it again.
        let child: ChildProcess | undefined;
        try {
          await holdForward(local, () => (child = slot.replace(() => spawn('ssh', sshArgs(target, heldForwardArgs(local, remote)), { stdio: 'ignore', env: { ...process.env, ...sshEnv } }))), 10_000,
            () => { if (child && slot.isCurrent(child)) forwards.lost(local); });
        } catch (error) {
          await slot.kill();
          throw error;
        }
        // Registered only now, so a remove() that ran meanwhile cannot miss it.
        held.set(local, slot);
        if (closed) { held.delete(local); await slot.kill(); throw disconnected(); }
      }
    },
    remove: async (local, remote) => {
      const slot = held.get(local);
      held.delete(local);
      const killed = slot?.kill();
      const cancelled = run('ssh', sshArgs(target, cancelArgs(local, remote)), { env: { ...process.env, ...sshEnv }, timeout: 10_000 }).catch(() => undefined);
      await Promise.all([killed, cancelled]);
    },
  });

  // SSH agent forwarding, off unless turned on for this machine: an unshared
  // connection with ForwardAgent keeps the remote end of the agent alive and
  // points run/agent.sock at it; new tmux sessions get that stable path as
  // SSH_AUTH_SOCK (the helper's tmux_service).
  let agentListener: (error: string | undefined) => void = () => undefined;
  const keeper = createAgentKeeper({
    spawn: () => spawn('ssh', agentKeeperArgs(target, home), { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...sshEnv } }),
    unlink: () => ssh(target, `rm -f "${home}/run/agent.sock"`, undefined, ['-o', 'BatchMode=yes'], 15_000),
    closed: () => closed,
    disconnected,
    report: (error) => { if (!closed) agentListener(error); },
  });

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
        const oldSocket = remote.socket;
        remote = await start(batch);
        if (closed) return;
        await tunnels.kill();
        await cancelForward(oldSocket);
        if (closed) return;
        openTunnel(batch);
        await waitHealthy(apiBase, 20_000);
        recovering = false;
        listener('connected', { tokenChanged: remote.token !== before });
        // Terminals need not wait for forwards. A close meanwhile is safe:
        // closeAll() undoes whatever restore() is still adding.
        if (!closed) { void forwards.restore(); keeper.restore(); }
        return;
      } catch (error) {
        tunnels.kill();
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
    tunnels.kill();
    throw error;
  }
  const watchdog = createWatchdog({
    check: () => healthOnce(apiBase, 5_000), intervalMs: 10_000, misses: 2,
    paused: () => closed || recovering, onDrop: () => void recover(),
  });
  return {
    apiBase,
    get token() { return remote.token; },
    label: target,
    usedPassword,
    close: () => {
      closed = true;
      watchdog.stop();
      tunnels.kill();
      wake?.();
      // The shared SSH connection holds the forward itself; give the port back now
      // rather than when that connection lapses.
      void cancelForward(remote.socket);
      void forwards.closeAll();
      keeper.close();
    },
    watch: (next) => { listener = next; },
    // A close while the forward is being made undoes it (Forwards.closeAll).
    forwardPort: async (remote) => {
      if (closed) throw disconnected();
      return forwards.open(remote);
    },
    setAgentForwarding: (on) => keeper.set(on),
    watchAgent: (next) => { agentListener = next; },
    reconnectNow: (asked) => {
      if (closed) return;
      if (asked) interactive = true;
      if (recovering) { const resume = wake; wake = null; resume?.(); }
      else if (asked) void recover();
      else watchdog.checkNow(1); // after sleep: one failed check is enough
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
