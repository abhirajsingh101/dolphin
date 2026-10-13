/* One watchdog loop for every machine link, local or SSH: a health check on
 * an interval, and a drop after `misses` failed checks in a row. And the loop
 * that brings this computer's helper back after a drop, which backs off and
 * gives up visibly rather than restarting a failing helper forever.
 * No Electron here (test/watchdog.test.mjs). */

export type Watchdog = { stop(): void; checkNow(assumeMisses?: number): void };

export function createWatchdog(options: {
  check: () => Promise<boolean>;
  intervalMs: number;
  misses: number;
  onDrop: () => void;
  /** True while the link is already recovering or closed: nothing to check. */
  paused?: () => boolean;
}): Watchdog {
  let misses = 0;
  let running = false;
  let stopped = false;
  const tick = async () => {
    if (stopped || running || options.paused?.()) return;
    running = true;
    try {
      misses = (await options.check().catch(() => false)) ? 0 : misses + 1;
    } finally {
      running = false;
    }
    if (!stopped && !options.paused?.() && misses >= options.misses) {
      misses = 0;
      options.onDrop();
    }
  };
  const timer = setInterval(() => void tick(), options.intervalMs);
  timer.unref?.();
  return {
    stop: () => { stopped = true; clearInterval(timer); },
    /** Check at once; `assumeMisses` counts that many failures already (after sleep, one more is enough). */
    checkNow: (assumeMisses = 0) => { misses = Math.max(misses, assumeMisses); void tick(); },
  };
}

export type RecoveryState = 'reconnecting' | 'connected' | 'offline';
export type Recovery = {
  /** Recover now; a second call while one runs joins it rather than racing it. */
  run(): Promise<void>;
  /** Cut the current pause short: Reconnect, a wake from sleep, or close. */
  wake(): void;
  readonly active: boolean;
};

export function createRecovery(options: {
  /** One try; resolves when the link is back, with what to tell the page. */
  attempt: (n: number) => Promise<{ tokenChanged?: boolean }>;
  onState: (state: RecoveryState, info: { reason?: string; tokenChanged?: boolean }) => void;
  /** The pause after failed try `n` (0-based). */
  delayMs: (n: number) => number;
  /** After this many failed tries in a row the link is offline until woken;
   *  `active` stays true meanwhile, so a watchdog paused on it stays paused. */
  giveUpAfter: number;
  closed: () => boolean;
}): Recovery {
  let running: Promise<void> | null = null;
  let wake: (() => void) | null = null;
  const pause = (ms: number | null) => new Promise<void>((resolve) => {
    const timer = ms === null ? null : setTimeout(() => { wake = null; resolve(); }, ms);
    timer?.unref?.();
    wake = () => { if (timer) clearTimeout(timer); wake = null; resolve(); };
  });
  const loop = async () => {
    options.onState('reconnecting', {});
    for (let n = 0, failed = 0; !options.closed(); n += 1) {
      try {
        const info = await options.attempt(n);
        if (options.closed()) return;
        options.onState('connected', info);
        return;
      } catch (error) {
        if (options.closed()) return;
        const reason = error instanceof Error ? error.message : String(error);
        failed += 1;
        if (failed >= options.giveUpAfter) {
          options.onState('offline', { reason });
          await pause(null);
          failed = 0;
          if (!options.closed()) options.onState('reconnecting', {});
        } else {
          options.onState('reconnecting', { reason });
          await pause(options.delayMs(n));
        }
      }
    }
  };
  return {
    run: () => {
      if (running || options.closed()) return running ?? Promise.resolve();
      running = loop().finally(() => { running = null; });
      return running;
    },
    wake: () => { const resume = wake; wake = null; resume?.(); },
    get active() { return running !== null; },
  };
}
