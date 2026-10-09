export interface ShortcutTargetLike {
  tagName?: string;
  isContentEditable?: boolean;
  closest?: (selectors: string) => unknown;
}

/** Containers that own every keystroke while focused. */
export const TYPING_CONTAINER_SELECTOR =
  '.terminal-host, .xterm, .xterm-helper-textarea, .cm-content, .cm-editor, [contenteditable="true"]';

const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/**
 * True when a global keyboard shortcut must NOT fire, because the user is
 * typing into a field, an editor, or the tmux terminal.
 */
export function isTypingTarget(
  target: ShortcutTargetLike | null | undefined,
): boolean {
  if (!target) return false;
  if (target.tagName && TYPING_TAGS.has(target.tagName.toUpperCase())) return true;
  if (target.isContentEditable) return true;
  if (typeof target.closest === 'function') {
    return target.closest(TYPING_CONTAINER_SELECTOR) != null;
  }
  return false;
}

/**
 * True when `target` is inside (or is) a container that owns every
 * keystroke — the live tmux terminal or a code editor surface. Unlike
 * `isTypingTarget`, this deliberately ignores plain form fields
 * (INPUT/TEXTAREA/SELECT/contentEditable): it exists so a shortcut that is
 * meant to bypass ordinary form fields (e.g. Cmd/Ctrl+K opening the command
 * palette from a text box) can still refuse to steal a keystroke that a
 * terminal or editor needs for itself — Ctrl+K is readline kill-line inside
 * an xterm session.
 */
export function isTerminalLikeTarget(
  target: ShortcutTargetLike | null | undefined,
): boolean {
  if (!target) return false;
  if (typeof target.closest === 'function') {
    return target.closest(TYPING_CONTAINER_SELECTOR) != null;
  }
  return false;
}
