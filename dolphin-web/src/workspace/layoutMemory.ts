import { clampChatWidth, CHAT_DEFAULT_WIDTH } from './chatColumn';

/* What the glass workspace's layout remembers across a relaunch (spec item 11):
   whether the sidebar is collapsed, the chat column's width and fold, and which
   project is fullscreen. The window's own size, maximized and full-screen state
   are the main process's (dolphin-desktop/src/windowState.ts). */

export const LAYOUT_KEYS = {
  sidebar: 'dolphin.glass.sidebar-collapsed',
  chat: 'dolphin.glass.chat',
  fullscreen: 'dolphin.glass.fullscreen-project',
} as const;
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function read(storage: Store | null, key: string): unknown {
  try { return JSON.parse(storage?.getItem(key) ?? 'null'); } catch { return null; }
}

export function readSidebarCollapsed(storage: Store | null): boolean {
  return read(storage, LAYOUT_KEYS.sidebar) === true;
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
    if (value === null) storage?.removeItem(key);
    else storage?.setItem(key, JSON.stringify(value));
  } catch { /* The layout is a convenience; the workspace works without it. */ }
}

export const browserStorage = (): Store | null => {
  try { return window.localStorage; } catch { return null; }
};
