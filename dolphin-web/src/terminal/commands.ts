import { zoomTerminals, type ZoomAction } from './fontZoom';

/* Commands the desktop menu sends (dolphinDesktop.onCommand, wired by the
   layout area), carried out here so the menu and in-terminal keys agree. */
export type TerminalCommandId = 'find' | ZoomAction;

const findTargets = new Map<string, () => void>();

/** Each glass terminal registers under its terminalKey. */
export function registerFindTarget(key: string, open: () => void): () => void {
  findTargets.set(key, open);
  return () => {
    if (findTargets.get(key) === open) findTargets.delete(key);
  };
}

/** `targetKey`: the focused session's terminalKey, for find. */
export function runTerminalCommand(id: TerminalCommandId, targetKey?: string | null): boolean {
  if (id === 'find') {
    const open = targetKey ? findTargets.get(targetKey) : undefined;
    open?.();
    return Boolean(open);
  }
  zoomTerminals(id);
  return true;
}
