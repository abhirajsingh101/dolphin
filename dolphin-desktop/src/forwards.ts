/* Ports on a machine reached over SSH, opened in this computer's browser.
 *
 * Each remote port gets one local port on 127.0.0.1, forwarded through the
 * machine's shared SSH connection (`ssh -O forward`, the ControlMaster the API
 * tunnel already uses). The mapping outlives the connection: after a
 * reconnect, restore() asks for the same local ports again, so a browser tab
 * left open keeps working. A local port taken meanwhile is dropped, and the
 * next open() picks a new one rather than pointing at someone else's server.
 *
 * Remote `localhost` links (a dev server's URL printed in a terminal) are
 * rewritten to the forwarded port. On this computer they open as they are.
 * No Electron here (test/forwards.test.mjs). */

import type { ChildProcess } from 'node:child_process';
import net from 'node:net';
import { isLoopbackHost } from './links';

export type ForwardOps = {
  add: (local: number, remote: number) => Promise<void>;
  remove: (local: number, remote: number) => Promise<void>;
  freePort: () => Promise<number>;
};

export const validPort = (port: number): boolean => Number.isInteger(port) && port > 0 && port < 65536;

const closedError = () => new Error('The machine was closed while its port was being forwarded.');

export class Forwards {
  private byRemote = new Map<number, number>();
  /** Opens still in flight, so two clicks on one port make one forward. */
  private opening = new Map<number, Promise<number>>();
  /** Local ports whose forward went away by itself (lost()): made again before reuse. */
  private stale = new Set<number>();
  /** Moves at closeAll(): an add that finishes after it is taken down again. */
  private generation = 0;

  constructor(private readonly ops: ForwardOps) {}

  /** The local port that reaches `remote` on the machine, forwarding it first if needed. */
  async open(remote: number): Promise<number> {
    if (!validPort(remote)) throw new Error(`${remote} is not a TCP port.`);
    const known = this.byRemote.get(remote);
    if (known !== undefined && !this.stale.has(known)) return known;
    const pending = this.opening.get(remote);
    if (pending) return pending;
    const next = this.make(remote, known);
    this.opening.set(remote, next);
    try {
      return await next;
    } finally {
      this.opening.delete(remote);
    }
  }

  private async make(remote: number, stale: number | undefined): Promise<number> {
    const generation = this.generation;
    if (stale !== undefined) {
      // The same port again, if it is still free to be ours; otherwise a new one.
      if (await this.added(stale, remote, generation)) {
        this.stale.delete(stale);
        return stale;
      }
      if (generation !== this.generation) throw closedError();
      this.stale.delete(stale);
      this.byRemote.delete(remote);
    }
    const local = await this.ops.freePort();
    await this.ops.add(local, remote);
    if (generation !== this.generation) {
      await this.ops.remove(local, remote).catch(() => undefined);
      throw closedError();
    }
    this.byRemote.set(remote, local);
    return local;
  }

  /** add(), undone if closeAll() ran meanwhile. False when it failed or was undone. */
  private async added(local: number, remote: number, generation: number): Promise<boolean> {
    try {
      await this.ops.add(local, remote);
    } catch {
      return false;
    }
    if (generation === this.generation) return true;
    await this.ops.remove(local, remote).catch(() => undefined);
    return false;
  }

  /** After a reconnect: the same local ports again, all at once, or none. */
  async restore(): Promise<void> {
    const generation = this.generation;
    await Promise.all([...this.byRemote].map(async ([remote, local]) => {
      const ok = await this.added(local, remote, generation);
      if (generation !== this.generation) return;
      this.stale.delete(local);
      if (!ok && this.byRemote.get(remote) === local) this.byRemote.delete(remote);
    }));
  }

  /** The forward on `local` went away by itself (its ssh exited): the next
   *  open() makes it again instead of handing out a port nothing holds. */
  lost(local: number): void {
    if ([...this.byRemote.values()].includes(local)) this.stale.add(local);
  }

  /** Every forward goes, including any still being made. The removes start
   *  together, so each one's first step (stopping its own ssh) runs before
   *  closeAll first yields. */
  async closeAll(): Promise<void> {
    this.generation += 1;
    const all = [...this.byRemote];
    this.byRemote.clear();
    this.stale.clear();
    await Promise.all(all.map(([remote, local]) => this.ops.remove(local, remote).catch(() => undefined)));
  }

  list(): { remote: number; local: number }[] {
    return [...this.byRemote].map(([remote, local]) => ({ remote, local }));
  }
}

/** An http(s) link to the machine it was printed on (links.ts decides what loopback is). */
export function isLoopbackUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  return isLoopbackHost(parsed.hostname);
}

export function remotePortOf(url: URL): number {
  return url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
}

/** The same link, on this computer's forwarded port. `localhost` names stay
 *  names (dev servers tie cookies and CORS to them); the forward listens on
 *  127.0.0.1, so IPv6 and numeric hosts become 127.0.0.1. */
export function rewriteToLocal(url: string, local: number): string {
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) parsed.hostname = host;
  else parsed.hostname = host === '0.0.0.0' || host === '[::]' ? 'localhost' : '127.0.0.1';
  parsed.port = String(local);
  return parsed.toString();
}

const spec = (local: number, remote: number) => `127.0.0.1:${local}:127.0.0.1:${remote}`;
export const forwardArgs = (local: number, remote: number): string[] => ['-O', 'forward', '-L', spec(local, remote)];
export const cancelArgs = (local: number, remote: number): string[] => ['-O', 'cancel', '-L', spec(local, remote)];
/** The same forward for an ssh of our own, when there is no shared connection to hand it to. */
export const heldForwardArgs = (local: number, remote: number): string[] => ['-N', '-o', 'ExitOnForwardFailure=yes', '-o', 'BatchMode=yes', '-L', spec(local, remote)];

/** Bind and close: 'free', 'taken' (EADDRINUSE and the like) or 'absent'
 *  (this computer has no such address, e.g. no IPv6). */
function probe(port: number, host: string): Promise<'free' | 'taken' | 'absent'> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (error: NodeJS.ErrnoException) => resolve(error.code === 'EADDRNOTAVAIL' || error.code === 'EAFNOSUPPORT' ? 'absent' : 'taken'));
    server.listen(port, host, () => server.close(() => resolve('free')));
  });
}

/** Whether port can be ours on 127.0.0.1 with nobody on [::1]: links open as
 *  `localhost`, which a browser may try on ::1 first. */
export async function portIsFree(port: number): Promise<boolean> {
  return (await probe(port, '127.0.0.1')) === 'free' && (await probe(port, '::1')) !== 'taken';
}

/** A port free on both loopbacks, for a new forward. */
export async function freeLocalPort(): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const { port: chosen } = server.address() as net.AddressInfo;
        server.close(() => resolve(chosen));
      });
    });
    if (await portIsFree(port)) return port;
  }
  throw new Error('No free port on this computer.');
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves once something accepts connections on 127.0.0.1:port. When
 *  `stop()` turns true the wait ends early, with the same rejection. */
export async function waitForPort(port: number, timeout: number, stop: () => boolean = () => false): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline && !stop()) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(false));
    });
    if (stop()) break;
    if (open) return;
    await sleep(200);
  }
  throw new Error(`The forward on port ${port} did not open.`);
}

/** Start an ssh of our own for a forward, and prove the port that answers is
 *  its. The port must be free before it starts (a server already there would
 *  pass for the forward), and when the port answers the ssh must still be
 *  running, or have handed the forward to a shared connection (exit 0). With
 *  ExitOnForwardFailure a refused forward exits non-zero, and whatever answers
 *  after that is someone else's. A non-zero exit later still is `onLost`. */
export async function holdForward(local: number, start: () => ChildProcess, timeout = 10_000, onLost?: (code: number | null) => void): Promise<ChildProcess> {
  if (!(await portIsFree(local))) throw new Error(`Port ${local} on this computer is in use by another program.`);
  const child = start();
  const outcome: { failed: Error | null; held: boolean } = { failed: null, held: false };
  child.once('exit', (code, signal) => {
    if (code === 0) return; // handed to a shared connection, which holds the port now
    // After the port opened: the forward is gone (and the port may be anyone's).
    if (outcome.held) onLost?.(code);
    else outcome.failed = new Error(`ssh could not forward port ${local} (${signal ?? `exit ${code}`}).`);
  });
  child.once('error', (error) => { outcome.failed = error; });
  try {
    await waitForPort(local, timeout, () => outcome.failed !== null);
    if (outcome.failed) throw outcome.failed;
  } catch (error) {
    if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL');
    throw outcome.failed ?? error;
  }
  outcome.held = true;
  return child;
}
