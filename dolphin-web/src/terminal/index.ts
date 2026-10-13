import type { Terminal } from '@xterm/xterm';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import type { TerminalPathResolution } from '@dolphin-terminal/protocol';

import { attachTerminalActivity } from './activity';
import { attachFontSize, refitTerminals, zoomTerminals } from './fontZoom';
import { downloadUrl, openWebLink } from './linkActions';
import { attachOsc8Links, attachWebLinks } from './links';
import { attachTerminalKeys } from './keys';
import { attachOsc52Clipboard, systemClipboardWrite } from './osc52';
import { attachPathLinks, createPathResolver } from './paths';
import { createFullscreenRenderer } from './webgl';

/* Dolphin's terminal features, attached to the package pane's xterm through
   onTerminal. The published @dolphin-terminal/react is not changed at source;
   each feature is a module beside this one. */

/** tmux owns the history; the browser keeps only a short local buffer. */
export const TERMINAL_SCROLLBACK = 1000;

export type TerminalFeatureOptions = {
  /** True on macOS: Cmd is the shortcut modifier there, Ctrl elsewhere. */
  mac: boolean;
  /** After an OSC 52 write: true when the clipboard took it. */
  onCopied: (ok: boolean) => void;
  writeClipboard?: (text: string) => Promise<void>;
  /** Where key presses are intercepted. Defaults to terminal.element. */
  keyTarget?: EventTarget;
  /** False while Dolphin Desktop's menu owns find and zoom. */
  appShortcuts: () => boolean;
  /** Opens find for this terminal. */
  onFind?: () => void;
  /** Re-fit after a font change. Defaults to refitTerminals. */
  refit?: () => void;
  /** The session's resolvePaths (the server decides which paths are files). */
  resolvePaths: (candidates: string[]) => Promise<TerminalPathResolution[]>;
  /** The machine's download URL for an absolute path. */
  fileUrl: (path: string) => string;
  download?: (url: string) => void;
  /** Opens an http(s) link. Defaults to window.open (noopener). */
  openWeb?: (href: string) => void;
  /** terminalKey(machine, project, session). */
  activityKey: string;
  /** True while visible && !collapsed && document.hasFocus(). */
  isForeground: () => boolean;
  /** An opaque CSS colour for the fullscreen terminal ('' keeps it transparent). */
  opaqueBackground: () => string;
};

export type TerminalFeatures = { setFullscreen(fullscreen: boolean): void; dispose(): void };

/** A feature: attaches to the terminal and may return its cleanup. */
export type FeatureModule = (terminal: Terminal, options: TerminalFeatureOptions) => void | (() => void);

const baseline: FeatureModule = (terminal) => {
  // Unicode 11 widths are a proposed API in xterm 6.
  terminal.options.allowProposedApi = true;
  terminal.options.scrollback = TERMINAL_SCROLLBACK;
  const unicode = new Unicode11Addon();
  terminal.loadAddon(unicode);
  terminal.unicode.activeVersion = '11';
  return () => unicode.dispose();
};

const osc52: FeatureModule = (terminal, options) => attachOsc52Clipboard(terminal, {
  writeText: options.writeClipboard ?? systemClipboardWrite,
  onResult: (ok) => options.onCopied(ok),
});

const keys: FeatureModule = (terminal, options) => {
  const keyTarget = options.keyTarget ?? terminal.element;
  if (!keyTarget) return;
  return attachTerminalKeys(terminal, keyTarget, {
    mac: options.mac,
    appShortcuts: options.appShortcuts,
    onShortcut: (shortcut) => {
      if (shortcut === 'find') {
        if (!options.onFind) return false;
        options.onFind();
        return true;
      }
      zoomTerminals(shortcut);
      return true;
    },
  });
};

const fontSize: FeatureModule = (terminal, options) => attachFontSize(terminal, options.refit ?? refitTerminals);

/* Links are looked up only when the pointer is over a row (xterm asks the
   provider on hover), so a hidden terminal never resolves anything, and the
   resolver remembers answers and batches by 300. */
const pathLinks: FeatureModule = (terminal, options) => attachPathLinks(terminal, {
  resolve: createPathResolver((candidates) => options.resolvePaths(candidates)),
  mac: options.mac,
  openFile: (path) => (options.download ?? downloadUrl)(options.fileUrl(path)),
});

/* http(s) text links and OSC 8 hyperlinks open on Cmd/Ctrl-click; file: links
   go through the machine's own download URL. */
const hyperlinks: FeatureModule = (terminal, options) => {
  const deps = {
    mac: options.mac,
    openWeb: options.openWeb ?? openWebLink,
    openFile: (path: string) => (options.download ?? downloadUrl)(options.fileUrl(path)),
  };
  const cleanups = [attachWebLinks(terminal, deps), attachOsc8Links(terminal, deps)];
  return () => cleanups.reverse().forEach((cleanup) => cleanup());
};

/* Titles, bells and OSC 9;4 progress feed the tab strip and the window title. */
const activity: FeatureModule = (terminal, options) => attachTerminalActivity(terminal, { key: options.activityKey, isForeground: options.isForeground });

const MODULES: FeatureModule[] = [baseline, osc52, keys, fontSize, pathLinks, hyperlinks, activity];

/* Each module's attach and cleanup run in their own try/catch: one failing
   module must not break the pane or the others. */
export function attachTerminalFeatures(
  terminal: Terminal,
  options: TerminalFeatureOptions,
  extra: FeatureModule[] = [],
): TerminalFeatures {
  const cleanups: Array<() => void> = [];
  for (const attach of [...MODULES, ...extra]) {
    try {
      const cleanup = attach(terminal, options);
      if (typeof cleanup === 'function') cleanups.push(cleanup);
    } catch (error) {
      console.error('terminal feature failed to attach', error);
    }
  }
  const renderer = createFullscreenRenderer(terminal, { opaqueBackground: options.opaqueBackground });
  cleanups.push(() => renderer.dispose());
  let disposed = false;
  return {
    setFullscreen(fullscreen) {
      if (!disposed) renderer.set(fullscreen);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const cleanup of cleanups.reverse()) {
        try {
          cleanup();
        } catch (error) {
          console.error('terminal feature failed to clean up', error);
        }
      }
    },
  };
}
