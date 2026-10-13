import type { Terminal } from '@xterm/xterm';

import {
  DEFAULT_SETTINGS,
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  getSetting,
  setSetting,
  subscribeSettings,
} from '../settings';

export type ZoomAction = 'zoom-in' | 'zoom-out' | 'zoom-reset';

export function zoomedFontSize(current: number, action: ZoomAction): number {
  if (action === 'zoom-reset') return DEFAULT_SETTINGS['terminal.fontSize'];
  const next = current + (action === 'zoom-in' ? 1 : -1);
  return Math.min(TERMINAL_FONT_SIZE_MAX, Math.max(TERMINAL_FONT_SIZE_MIN, next));
}

/** Zoom is one setting, so every open terminal follows it. */
export function zoomTerminals(action: ZoomAction): void {
  setSetting('terminal.fontSize', zoomedFontSize(getSetting('terminal.fontSize'), action));
}

let refitQueued = false;

/* The package pane re-fits, and sends tmux the new size, on a window resize:
   the only refit it exposes. One event per frame covers every terminal, after
   xterm has re-measured its cells for the new font. */
export function refitTerminals(): void {
  if (typeof window === 'undefined') return;
  if (refitQueued) return;
  refitQueued = true;
  window.requestAnimationFrame(() => {
    refitQueued = false;
    window.dispatchEvent(new Event('resize'));
  });
}

export function attachFontSize(terminal: Terminal, refit: () => void): () => void {
  const apply = () => {
    const size = getSetting('terminal.fontSize');
    if (terminal.options.fontSize === size) return;
    terminal.options.fontSize = size;
    refit();
  };
  apply();
  return subscribeSettings(apply);
}
