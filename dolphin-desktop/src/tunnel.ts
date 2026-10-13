/* The one SSH forward a machine link has at a time. A recovery replaces it:
 * the old `ssh -N -L` is killed before the new one starts, so two never race
 * for the same loopback port. No Electron here (test/tunnel.test.mjs). */

type Killable = { kill(signal?: NodeJS.Signals | number): boolean; exitCode: number | null; signalCode?: NodeJS.Signals | null };

export class TunnelSlot<T extends Killable> {
  current: T | null = null;

  replace(open: () => T): T {
    this.kill();
    const next = open();
    this.current = next;
    return next;
  }

  isCurrent(child: T): boolean {
    return this.current === child;
  }

  /** Stop the running tunnel. Resolves once it has exited: SIGTERM first,
   *  SIGKILL if it is still there after `graceMs`. */
  kill(graceMs = 2_000): Promise<void> {
    const old = this.current;
    this.current = null;
    if (!old || old.exitCode !== null || old.signalCode) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const waitable = old as unknown as { once?: (event: 'exit', cb: () => void) => void };
      if (!waitable.once) { old.kill(); resolve(); return; }
      const timer = setTimeout(() => { old.kill('SIGKILL'); }, graceMs);
      waitable.once('exit', () => { clearTimeout(timer); resolve(); });
      old.kill();
    });
  }
}
