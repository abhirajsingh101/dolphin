/* The window's maximized and full-screen state across a relaunch (spec item 11).
   Bounds, and keeping them on an attached display, are saved beside these in
   session.json by main.ts. */

export type WindowFlags = { maximized: boolean; fullScreen: boolean };
type FlagWindow = { isMaximized(): boolean; isFullScreen(): boolean; maximize(): void; setFullScreen(on: boolean): void };

/** A live window's flags; with no window, what was saved before. */
export function windowFlags(window: FlagWindow | null, saved: Partial<Record<keyof WindowFlags, unknown>> = {}): WindowFlags {
  if (!window) return { maximized: saved.maximized === true, fullScreen: saved.fullScreen === true };
  return { maximized: window.isMaximized(), fullScreen: window.isFullScreen() };
}

export function applyWindowFlags(window: FlagWindow, saved: Partial<Record<keyof WindowFlags, unknown>>): void {
  if (saved.fullScreen === true) window.setFullScreen(true);
  else if (saved.maximized === true) window.maximize();
}
