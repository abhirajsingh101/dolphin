/* What Dolphin remembers between launches (session.json, machines.json) and
 * the rules for saving it. No Electron here, so it is tested directly
 * (test/session-store.test.mjs). */

import { closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';

export type Bounds = { x: number; y: number; width: number; height: number };
/** One Dolphin window: its number (which layout it keeps, see the page's
 *  windowScope.ts), its place, and its maximized and full-screen state. */
export type SavedWindow = { slot: number; bounds?: Bounds; maximized: boolean; fullScreen: boolean };
/** `bounds`, `maximized` and `fullScreen` are the front window's, as before
 *  0.2.3 when there was only one; `windows` is every window, front one last. */
export type Saved = { machines?: string[]; bounds?: Bounds; open?: { target: string; bounds?: Bounds }[]; systemNotifications?: boolean; maximized?: boolean; fullScreen?: boolean; windows?: SavedWindow[] };

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

export type LiveSession = { machines: string[]; bounds?: Bounds; flags?: { maximized: boolean; fullScreen: boolean }; windows?: SavedWindow[] };

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
  const windows = live.windows ?? saved.windows;
  if (windows) state.windows = windows;
  return state;
}

/** More than this many windows in session.json is a damaged or hand-edited file. */
const MAX_WINDOWS = 12;
const isBounds = (value: unknown): value is Bounds => Boolean(value) && typeof value === 'object'
  && ['x', 'y', 'width', 'height'].every((key) => Number.isFinite((value as Record<string, unknown>)[key]));

/** The windows to open at launch, back one first. A session from before 0.2.3
 *  (or one whose list is unusable) is a single window, number 1, in its old place. */
export function windowsToRestore(saved: Saved): SavedWindow[] {
  const seen = new Set<number>();
  const windows: SavedWindow[] = [];
  for (const item of Array.isArray(saved.windows) ? saved.windows as unknown[] : []) {
    if (!item || typeof item !== 'object') continue;
    const { slot, bounds, maximized, fullScreen } = item as Record<string, unknown>;
    if (typeof slot !== 'number' || !Number.isInteger(slot) || slot < 1 || seen.has(slot)) continue;
    seen.add(slot);
    windows.push({ slot, bounds: isBounds(bounds) ? bounds : undefined, maximized: maximized === true, fullScreen: fullScreen === true });
    if (windows.length === MAX_WINDOWS) break;
  }
  if (windows.length) return windows;
  return [{ slot: 1, bounds: saved.bounds ?? saved.open?.[0]?.bounds, maximized: saved.maximized === true, fullScreen: saved.fullScreen === true }];
}

/** A new window's number: the lowest one no open window has. */
export function freeSlot(used: Iterable<number>): number {
  const taken = new Set(used);
  let slot = 1;
  while (taken.has(slot)) slot += 1;
  return slot;
}

/** The windows to save once closes settle (Quit saves them all first, so it
 *  never gets here): those still open; or, when none is, every window that was
 *  open before the closes began, so the next launch (or macOS reopening from
 *  the Dock) brings back the last window, or all of them after a Close All. */
export function windowsAfterCloses(before: SavedWindow[], open: SavedWindow[]): SavedWindow[] {
  return open.length ? open : before;
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

/** A second launch of Dolphin: bring the front window forward, or restore the
 *  last session when no window is open (macOS after closing them). Launched
 *  with --new-window (the Dock menu, a launcher's New Window action), it opens
 *  another window when one is already open. */
export function secondInstanceAction(ready: boolean, hasWindow: boolean, argv: readonly string[] = []): 'show' | 'restore' | 'wait' | 'new-window' {
  if (!ready) return 'wait';
  if (!hasWindow) return 'restore';
  return argv.includes('--new-window') ? 'new-window' : 'show';
}
