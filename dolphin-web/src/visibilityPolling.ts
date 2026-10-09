export interface VisibilitySource {
  visibilityState: DocumentVisibilityState;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

interface PollingTimers {
  setInterval(callback: () => void, intervalMs: number): number;
  clearInterval(id: number): void;
}

interface VisibilityPollingOptions {
  intervalMs: number;
  poll: () => void | Promise<void>;
  runOnStart?: boolean;
  source?: VisibilitySource;
  timers?: PollingTimers;
}

export function startVisibilityAwarePolling({
  intervalMs,
  poll,
  runOnStart = true,
  source = document,
  timers = window,
}: VisibilityPollingOptions): () => void {
  let stopped = false;
  let inFlight = false;
  let intervalId: number | null = null;

  const clearTimer = () => {
    if (intervalId === null) return;
    timers.clearInterval(intervalId);
    intervalId = null;
  };

  const run = async (force = false) => {
    if (stopped || inFlight) return;
    if (!force && source.visibilityState === 'hidden') return;
    inFlight = true;
    try {
      await poll();
    } finally {
      inFlight = false;
    }
  };

  const schedule = () => {
    clearTimer();
    if (stopped || source.visibilityState === 'hidden') return;
    intervalId = timers.setInterval(() => {
      void run();
    }, intervalMs);
  };

  const handleVisibilityChange = () => {
    schedule();
    if (source.visibilityState !== 'hidden') void run();
  };

  source.addEventListener('visibilitychange', handleVisibilityChange);
  schedule();
  /* The first fetch is deliberately NOT gated on visibility, while every
     later one is. Skipping it leaves a surface opened in a background tab
     stuck on its loading state until the tab is focused. This is one request,
     at mount;
     the repeated background polling this helper exists to suppress is still
     suppressed. */
  if (runOnStart) void run(true);

  return () => {
    stopped = true;
    clearTimer();
    source.removeEventListener('visibilitychange', handleVisibilityChange);
  };
}
