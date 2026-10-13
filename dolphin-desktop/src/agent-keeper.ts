/* SSH agent forwarding for one machine link: at most one keeper (an unshared
 * `ssh -o ForwardAgent=yes` running sshArgs.ts agentKeeperScript) at a time.
 * Same discipline as the link's tunnel: a reconnect replaces the keeper and
 * never adds a second, a close kills it and nothing starts after, and turning
 * it off kills it and removes the machine's agent link. No Electron here
 * (test/agent-forwarding.test.mjs). */

import type { ChildProcess } from 'node:child_process';
import { TunnelSlot } from './tunnel';

type Result = { ok?: true; error?: string };
export type AgentKeeperOps = {
  /** Start the keeper's ssh, stdin piped (the remote end waits on it). */
  spawn: () => ChildProcess;
  /** Remove the machine's agent link (after turning off). */
  unlink: () => Promise<unknown>;
  /** The link was closed: nothing may start any more. */
  closed: () => boolean;
  disconnected: () => Error;
  /** Forwarding that was on broke by itself (an error), or came back (undefined). */
  report?: (error: string | undefined) => void;
  readyMs?: number;
};

export const AGENT_STOPPED = 'Agent forwarding stopped. Reconnect to restore it.';
/** Enough of ssh's error output to say why; the rest is dropped. */
const STDERR_CAP = 4096;

/** A start cut short by a newer start, a close, or turning off. */
class Superseded extends Error {}

export function createAgentKeeper(ops: AgentKeeperOps) {
  const slot = new TunnelSlot<ChildProcess>();
  const readyMs = ops.readyMs ?? 30_000;
  let wanted = false;
  let ready: ChildProcess | null = null;
  let pending: Promise<void> | null = null;
  /** Turning off: the keeper's kill and the link's rm. A turn back on waits for it. */
  let stopping: Promise<void> | null = null;
  const live = (child: ChildProcess | null) => Boolean(child && slot.isCurrent(child) && child.exitCode === null && !child.signalCode);

  const start = (): Promise<void> => {
    if (ops.closed()) return Promise.reject(ops.disconnected());
    ready = null;
    const child = slot.replace(ops.spawn);
    const started = new Promise<void>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      const done = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error); else resolve();
      };
      const timer = setTimeout(() => {
        if (slot.isCurrent(child)) void slot.kill();
        done(new Error(`Agent forwarding did not start within ${Math.round(readyMs / 1000)} seconds.`));
      }, readyMs);
      // Nothing is ever written: the pipe is only held, so the remote end waits on it.
      child.stdin?.on('error', () => undefined);
      child.stdout?.on('data', (chunk) => {
        stdout += chunk;
        if (!/(^|\n)ready\n/.test(stdout)) return;
        if (slot.isCurrent(child)) { ready = child; done(); } else done(new Superseded());
      });
      // Collected until it starts, and capped: a running keeper says nothing worth keeping.
      child.stderr?.on('data', (chunk) => { if (!settled && stderr.length < STDERR_CAP) stderr = (stderr + chunk).slice(0, STDERR_CAP); });
      child.once('error', (error) => done(error));
      child.once('exit', (code) => {
        const wasReady = ready === child;
        if (wasReady) ready = null;
        // Killed by us (replaced, closed, turned off): no longer current.
        const byItself = slot.isCurrent(child);
        if (wasReady && byItself && wanted && !ops.closed()) ops.report?.(AGENT_STOPPED);
        done(byItself ? new Error(stderr.trim() || `Agent forwarding stopped (${code}).`) : new Superseded());
      });
    });
    pending = started;
    const clear = () => { if (pending === started) pending = null; };
    started.then(clear, clear);
    return started;
  };

  const on = async (): Promise<Result> => {
    wanted = true;
    // An off still removing the link would remove the one this on makes.
    while (stopping) await stopping;
    for (;;) {
      if (ops.closed()) return { error: ops.disconnected().message };
      if (live(ready)) return { ok: true };
      try {
        await (pending ?? start());
      } catch (error) {
        if (!(error instanceof Superseded)) return { error: error instanceof Error ? error.message : String(error) };
        // A newer start (a reconnect) took over: wait for that one instead.
        if (wanted && !ops.closed()) continue;
        return ops.closed() ? { error: ops.disconnected().message } : { ok: true };
      }
    }
  };

  const off = async (): Promise<Result> => {
    wanted = false;
    ready = null;
    const work = (async () => {
      await slot.kill();
      // A link left behind (the machine is unreachable now) points at a socket
      // sshd has removed; the helper hands out only a link that resolves to a socket.
      if (!ops.closed()) await ops.unlink().catch(() => undefined);
    })();
    stopping = work;
    await work;
    if (stopping === work) stopping = null;
    return { ok: true };
  };

  return {
    set: (enable: boolean): Promise<Result> => (enable ? on() : off()),
    /** After a reconnect: the old keeper went with the old connection. */
    restore: (): void => {
      if (!wanted || ops.closed() || stopping) return;
      start().then(() => ops.report?.(undefined), (error) => {
        if (!(error instanceof Superseded) && wanted && !ops.closed()) ops.report?.(error instanceof Error ? error.message : String(error));
      });
    },
    /** The link is closed: stop the keeper now (the app may be exiting). */
    close: (): void => {
      ready = null;
      void slot.kill();
    },
  };
}
