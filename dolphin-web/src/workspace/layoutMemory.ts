import { clampChatWidth, CHAT_DEFAULT_WIDTH } from './chatColumn';
import { windowKey } from './windowScope';

/* What the glass workspace's layout remembers across a relaunch (spec item 11):
   whether the sidebar is collapsed, the chat column's width and fold, and which
   project is fullscreen. The window's own size, maximized and full-screen state
   are the main process's (dolphin-desktop/src/windowState.ts). Each Dolphin
   window keeps its own (windowScope.ts). */

export const LAYOUT_KEYS = {
  sidebar: 'dolphin.glass.sidebar-collapsed',
  sidebarWidth: 'dolphin.glass.sidebar-width',
  chat: 'dolphin.glass.chat',
  fullscreen: 'dolphin.glass.fullscreen-project',
} as const;
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function read(storage: Store | null, key: string): unknown {
  try { return JSON.parse(storage?.getItem(windowKey(key)) ?? 'null'); } catch { return null; }
}

export function readSidebarCollapsed(storage: Store | null): boolean {
  return read(storage, LAYOUT_KEYS.sidebar) === true;
}

/* The projects list's width, dragged at its right edge. The 216px default is
   what keeps an open terminal at 100 columns beside the chat at 1440×900
   (design contract §4); wider is a drag away and remembered. Past 420px the
   list stops gaining anything and only costs terminal columns. */
export const SIDEBAR_DEFAULT_WIDTH = 216;
export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 420;

export function clampSidebarWidth(width: unknown): number {
  if (typeof width !== 'number' || !Number.isFinite(width)) return SIDEBAR_DEFAULT_WIDTH;
  return Math.round(Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width)));
}

export function readSidebarWidth(storage: Store | null): number {
  return clampSidebarWidth(read(storage, LAYOUT_KEYS.sidebarWidth));
}

export function readChatLayout(storage: Store | null): { width: number; collapsed: boolean } {
  const saved = read(storage, LAYOUT_KEYS.chat) as { width?: unknown; collapsed?: unknown } | null;
  if (!saved || typeof saved !== 'object') return { width: CHAT_DEFAULT_WIDTH, collapsed: false };
  return { width: clampChatWidth(saved.width), collapsed: saved.collapsed === true };
}

export function readFullscreenProject(storage: Store | null): string | null {
  const saved = read(storage, LAYOUT_KEYS.fullscreen);
  return typeof saved === 'string' && saved ? saved : null;
}

export function writeLayout(storage: Store | null, key: string, value: unknown): void {
  try {
    if (value === null) storage?.removeItem(windowKey(key));
    else storage?.setItem(windowKey(key), JSON.stringify(value));
  } catch { /* The layout is a convenience; the workspace works without it. */ }
}

export const browserStorage = (): Store | null => {
  try { return window.localStorage; } catch { return null; }
};
