/* A plain click in a terminal focuses it and goes to tmux (mouse mode), so a
   link opens on Cmd-click (macOS) or Ctrl-click, as in VS Code's terminal. */
export function isLinkActivation(event: Pick<MouseEvent, 'button' | 'metaKey' | 'ctrlKey'>, mac: boolean): boolean {
  return event.button === 0 && (mac ? event.metaKey : event.ctrlKey);
}

/* Dolphin Desktop's window-open handler sends http(s) to the system browser. */
export function openWebLink(href: string): void {
  window.open(href, '_blank', 'noopener,noreferrer');
}

/* The same mechanism as select mode's links: an anchor with `download`. */
export function downloadUrl(url: string): void {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = '';
  anchor.rel = 'noopener';
  anchor.hidden = true;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}
