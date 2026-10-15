/* Dolphin Desktop can open several windows of the same workspace (File → New
   Window). They share one origin, so one localStorage: settings, the theme,
   pins, seen turns and the projects list's folds are shared by every window,
   while each window keeps its own layout (its open project windows and tabs,
   sidebar, chat column, chat tabs and drafts) under its own keys. The first
   window, and the web app, use the plain keys, so nothing saved before
   windows existed is lost. */

export const WINDOW_KEYS = [
  'dolphin.glass.windows',
  'dolphin.glass.project-tabs',
  'dolphin.glass.sidebar-collapsed',
  'dolphin.glass.sidebar-width',
  'dolphin.glass.fullscreen-project',
  'dolphin.glass.chat',
  'dolphin.glass.chat-tabs',
  'dolphin.glass.chat-thread',
  'dolphin.glass.chat-draft',
] as const;

type WindowInfo = { slot: number; fresh: boolean };
type Store = Pick<Storage, 'removeItem'>;

const windowInfo = (): WindowInfo | undefined =>
  (globalThis as { dolphinDesktop?: { window?: WindowInfo } }).dolphinDesktop?.window;

/** Where this window keeps `key`, one of WINDOW_KEYS. */
export function windowKey(key: string): string {
  if (!(WINDOW_KEYS as readonly string[]).includes(key)) throw new Error(`${key} is not a window key`);
  const slot = windowInfo()?.slot ?? 1;
  return slot > 1 ? `${key}@${slot}` : key;
}

/** Before the workspace reads its layout: a window New Window just opened
 *  starts empty, rather than with what a closed window of the same number left. */
export function startWindow(storage: Store | null): void {
  if (!windowInfo()?.fresh) return;
  for (const key of WINDOW_KEYS) {
    try { storage?.removeItem(windowKey(key)); } catch { /* the layout is a convenience */ }
  }
}
