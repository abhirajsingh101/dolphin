/* What Dolphin remembers between launches (session.json, machines.json) and
 * the rules for saving it. No Electron here, so it is tested directly
 * (test/session-store.test.mjs). */

import { closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';

export type Bounds = { x: number; y: number; width: number; height: number };
export type Saved = { machines?: string[]; bounds?: Bounds; open?: { target: string; bounds?: Bounds }[]; systemNotifications?: boolean; maximized?: boolean; fullScreen?: boolean };

/** A JSON object from `file`, or `fallback` when it is missing, truncated or not an object. */
export function readJson<T>(file: string, fallback: T): T {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as T) : fallback;
  } catch {
    return fallback;
  }
}

/** Write JSON so a crash or a full disk never leaves half a file: a temporary
 *  file beside it, flushed to disk, then renamed over it. */
export function writeJsonAtomic(file: string, value: unknown): void {
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    const descriptor = openSync(temporary, 'w', 0o600);
    try {
      writeSync(descriptor, JSON.stringify(value, null, 2));
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

export type LiveSession = { machines: string[]; bounds?: Bounds; flags?: { maximized: boolean; fullScreen: boolean } };

/** What to write at a save point: the live machines, whether or not a window
 *  is open (macOS keeps them connected after the window closes, so Quit then
 *  saves them), in the window's place, or the saved place with no window. */
/** The last "system notifications" setting the page sent, read at startup
 *  so an off setting holds before the page loads. Unset means on. */
export function savedSystemNotifications(saved: Saved): boolean {
  return saved.systemNotifications !== false;
}

export function sessionToSave(saved: Saved, live: LiveSession): Saved {
  const state: Saved = { machines: [...live.machines], bounds: live.bounds ?? saved.bounds };
  if (typeof saved.systemNotifications === 'boolean') state.systemNotifications = saved.systemNotifications;
  // A live window's flags, otherwise what was saved before.
  const maximized = live.flags?.maximized ?? saved.maximized;
  const fullScreen = live.flags?.fullScreen ?? saved.fullScreen;
  if (typeof maximized === 'boolean') state.maximized = maximized;
  if (typeof fullScreen === 'boolean') state.fullScreen = fullScreen;
  return state;
}

const MIN_VISIBLE = 100;

/** The saved place, moved onto the attached screen it overlaps most, or
 *  undefined (the default place) when less than 100x100 of it would show. */
export function clampBounds(bounds: Bounds | undefined, workAreas: Bounds[]): Bounds | undefined {
  if (!bounds || workAreas.length === 0) return undefined;
  const overlapX = (area: Bounds) => Math.max(0, Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x));
  const overlapY = (area: Bounds) => Math.max(0, Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y));
  const best = workAreas.reduce((a, b) => (overlapX(b) * overlapY(b) > overlapX(a) * overlapY(a) ? b : a));
  if (overlapX(best) < MIN_VISIBLE || overlapY(best) < MIN_VISIBLE) return undefined;
  const width = Math.min(bounds.width, best.width);
  const height = Math.min(bounds.height, best.height);
  return {
    x: Math.min(Math.max(bounds.x, best.x), best.x + best.width - width),
    y: Math.min(Math.max(bounds.y, best.y), best.y + best.height - height),
    width,
    height,
  };
}

/** A second launch of Dolphin: bring the window forward, or restore the last
 *  session when no window is open (macOS after closing it). */
export function secondInstanceAction(ready: boolean, hasWindow: boolean): 'show' | 'restore' | 'wait' {
  if (!ready) return 'wait';
  return hasWindow ? 'show' : 'restore';
}
