import { describe, expect, it } from 'vitest';

import {
  startVisibilityAwarePolling,
  type VisibilitySource,
} from './visibilityPolling';

class FakeVisibilitySource implements VisibilitySource {
  visibilityState: DocumentVisibilityState = 'hidden';
  private listener: (() => void) | null = null;

  addEventListener(_type: 'visibilitychange', listener: () => void) {
    this.listener = listener;
  }

  removeEventListener(_type: 'visibilitychange', listener: () => void) {
    if (this.listener === listener) this.listener = null;
  }

  setVisibility(next: DocumentVisibilityState) {
    this.visibilityState = next;
    this.listener?.();
  }
}

describe('visibility-aware polling', () => {
  it('stays quiet while hidden, refreshes on return, and never overlaps', async () => {
    const source = new FakeVisibilitySource();
    const intervals = new Map<number, () => void>();
    const cleared: number[] = [];
    let nextIntervalId = 1;
    let resolvePoll: () => void = () => undefined;
    let pollCount = 0;

    const stop = startVisibilityAwarePolling({
      intervalMs: 3_000,
      poll: () => {
        pollCount += 1;
        return new Promise<void>((resolve) => {
          resolvePoll = resolve;
        });
      },
      source,
      timers: {
        setInterval(callback) {
          const id = nextIntervalId++;
          intervals.set(id, callback);
          return id;
        },
        clearInterval(id) {
          cleared.push(id);
          intervals.delete(id);
        },
      },
    });

    // No interval while hidden, but the one initial fetch still ran: a
    // surface mounted in a background tab has to resolve to real data
    // instead of sitting on its loading state until the tab is focused.
    expect(intervals.size).toBe(0);
    expect(pollCount).toBe(1);
    resolvePoll();
    await Promise.resolve();

    source.setVisibility('visible');
    expect(intervals.size).toBe(1);
    expect(pollCount).toBe(2);

    [...intervals.values()][0]();
    expect(pollCount).toBe(2);

    resolvePoll();
    await Promise.resolve();
    [...intervals.values()][0]();
    expect(pollCount).toBe(3);

    source.setVisibility('hidden');
    expect(intervals.size).toBe(0);
    expect(cleared).toHaveLength(1);

    stop();
    expect(intervals.size).toBe(0);
  });

  it('polls nothing on a timer while hidden, even after the initial fetch', async () => {
    /* The initial fetch is exempt from the visibility gate; the interval is
       not. Without this, "run the first one anyway" could be read as
       "the gate is gone" and a hidden tab would poll forever. */
    const source = new FakeVisibilitySource();
    const intervals = new Map<number, () => void>();
    let nextIntervalId = 1;
    let pollCount = 0;

    const stop = startVisibilityAwarePolling({
      intervalMs: 3_000,
      poll: () => {
        pollCount += 1;
      },
      source,
      timers: {
        setInterval(callback) {
          const id = nextIntervalId++;
          intervals.set(id, callback);
          return id;
        },
        clearInterval(id) {
          intervals.delete(id);
        },
      },
    });

    expect(pollCount).toBe(1);
    await Promise.resolve(); // let `run`'s in-flight guard clear

    // Become visible (an interval is armed), then hide again and fire the
    // timer by hand: the gate must still refuse it.
    source.setVisibility('visible');
    const timer = [...intervals.values()][0];
    expect(pollCount).toBe(2);
    await Promise.resolve();
    source.visibilityState = 'hidden';
    timer();
    expect(pollCount).toBe(2);

    stop();
  });

  it('skips the initial fetch when the caller asks it to', () => {
    const source = new FakeVisibilitySource();
    source.visibilityState = 'visible';
    let pollCount = 0;

    const stop = startVisibilityAwarePolling({
      intervalMs: 3_000,
      poll: () => {
        pollCount += 1;
      },
      runOnStart: false,
      source,
      timers: {
        setInterval: () => 1,
        clearInterval: () => undefined,
      },
    });

    expect(pollCount).toBe(0);
    stop();
  });
});
