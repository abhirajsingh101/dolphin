import type { ILinkHandler, Terminal } from '@xterm/xterm';
import { WebLinksAddon } from '@xterm/addon-web-links';

import { isLinkActivation } from './linkActions';

export type TerminalLinkTarget = { kind: 'web'; href: string } | { kind: 'file'; path: string };
export type LinkDeps = { mac: boolean; openWeb(href: string): void; openFile(path: string): void };

/** What a link may open. Anything but http(s) and file is ignored. The text is
 *  untrusted terminal output: it is only parsed, never rendered as HTML. */
export function classifyTerminalLink(uri: string): TerminalLinkTarget | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if (url.protocol === 'http:' || url.protocol === 'https:') return { kind: 'web', href: url.href };
  if (url.protocol !== 'file:') return null;
  try {
    // file://<host>/path names a path on the machine the session runs on.
    const path = decodeURIComponent(url.pathname);
    return path.startsWith('/') && path.length > 1 ? { kind: 'file', path } : null;
  } catch {
    return null;
  }
}

export function handleWebLink(event: MouseEvent, uri: string, deps: LinkDeps): void {
  if (!isLinkActivation(event, deps.mac)) return;
  const target = classifyTerminalLink(uri);
  if (target?.kind === 'web') deps.openWeb(target.href);
}

export function attachWebLinks(terminal: Terminal, deps: LinkDeps): () => void {
  const addon = new WebLinksAddon((event, uri) => handleWebLink(event, uri, deps));
  terminal.loadAddon(addon);
  return () => addon.dispose();
}

/* OSC 8 hyperlinks (tmux forwards them with the "hyperlinks" feature). */
export function terminalLinkHandler(deps: LinkDeps): ILinkHandler {
  return {
    allowNonHttpProtocols: true,
    activate(event, text) {
      if (!isLinkActivation(event, deps.mac)) return;
      const target = classifyTerminalLink(text);
      if (target?.kind === 'web') deps.openWeb(target.href);
      else if (target?.kind === 'file') deps.openFile(target.path);
    },
  };
}

export function attachOsc8Links(terminal: Terminal, deps: LinkDeps): () => void {
  terminal.options.linkHandler = terminalLinkHandler(deps);
  return () => {
    terminal.options.linkHandler = null;
  };
}
