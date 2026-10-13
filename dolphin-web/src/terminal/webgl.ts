import type { ITerminalAddon, ITheme, Terminal } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';

/* WebGL while fullscreen, on an opaque background. On the transparent glass
   theme addon-webgl 0.19 paints dim cells' background rectangles opaque
   black; with an opaque theme those rectangles are the background colour. */

export type WebglRenderer = ITerminalAddon & { onContextLoss(listener: () => void): { dispose(): void } };

export function createFullscreenRenderer(
  terminal: Terminal,
  deps: { opaqueBackground: () => string; createWebgl?: () => WebglRenderer },
): { set(fullscreen: boolean): void; dispose(): void } {
  const create = deps.createWebgl ?? (() => new WebglAddon());
  let addon: WebglRenderer | null = null;
  let loss: { dispose(): void } | null = null;
  let restore: ITheme | null = null;

  const release = () => {
    loss?.dispose();
    loss = null;
    const current = addon;
    addon = null;
    current?.dispose(); // xterm falls back to its DOM renderer
  };
  const leave = () => {
    release();
    if (restore) terminal.options.theme = restore;
    restore = null;
  };

  return {
    set(fullscreen) {
      if (!fullscreen) {
        leave();
        return;
      }
      if (restore) return;
      const background = deps.opaqueBackground().trim();
      if (!background) return;
      restore = { ...(terminal.options.theme ?? {}) };
      terminal.options.theme = { ...restore, background };
      try {
        const next = create();
        terminal.loadAddon(next);
        addon = next;
        loss = next.onContextLoss(release);
      } catch {
        addon = null; // no usable WebGL: the DOM renderer, now opaque, stands
      }
    },
    dispose: leave,
  };
}
