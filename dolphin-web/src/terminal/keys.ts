import type { Terminal } from '@xterm/xterm';

/** What a key press in a terminal means to Dolphin, if anything. */
export type TerminalKeyAction = 'newline' | 'find' | 'zoom-in' | 'zoom-out' | 'zoom-reset';
export type TerminalShortcut = Exclude<TerminalKeyAction, 'newline'>;

export type KeyLike = {
  type: string;
  key: string;
  code: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
};

/** ESC CR: what Claude Code and Codex read as "new line, don't submit". */
export const NEWLINE_SEQUENCE = '\x1b\r';

export function terminalKeyAction(event: KeyLike, mac: boolean): TerminalKeyAction | null {
  if (event.type !== 'keydown' || event.isComposing || event.keyCode === 229) return null;
  if (event.key === 'Enter') {
    return event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey ? 'newline' : null;
  }
  if (event.altKey) return null;
  const modifier = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!modifier) return null;
  const key = event.key.toLowerCase();
  // Ctrl+F is forward-char in readline and page-down in vim, so off macOS
  // find also takes Shift. On macOS it is plain Cmd+F.
  if (key === 'f') return event.shiftKey === !mac ? 'find' : null;
  if (key === '=' || key === '+' || event.code === 'NumpadAdd') return 'zoom-in';
  // Ctrl+Shift+- is Ctrl+_ (undo in readline): only the unshifted minus zooms.
  if ((key === '-' && !event.shiftKey) || event.code === 'NumpadSubtract') return 'zoom-out';
  if ((key === '0' && !event.shiftKey) || event.code === 'Numpad0') return 'zoom-reset';
  return null;
}

/**
 * Listens in the capture phase on an ancestor of xterm's textarea, so a key
 * Dolphin consumes never reaches xterm. `onShortcut` returns false when it
 * did nothing, and the key then goes to the program as usual.
 */
export function attachTerminalKeys(
  terminal: Pick<Terminal, 'input'>,
  target: EventTarget,
  options: { mac: boolean; appShortcuts: () => boolean; onShortcut: (shortcut: TerminalShortcut) => boolean },
): () => void {
  const listener = (event: Event) => {
    const action = terminalKeyAction(event as unknown as KeyLike, options.mac);
    if (!action) return;
    if (action === 'newline') terminal.input(NEWLINE_SEQUENCE, true);
    else if (!options.appShortcuts() || !options.onShortcut(action)) return;
    event.preventDefault();
    event.stopPropagation();
  };
  target.addEventListener('keydown', listener, { capture: true });
  return () => target.removeEventListener('keydown', listener, { capture: true });
}
