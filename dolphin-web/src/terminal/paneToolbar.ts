/* The glass window header hides @dolphin-terminal/react's own toolbar and
   runs its buttons from one overflow menu, finding them by title, and reads
   the connection state from its pill. These are the package's strings
   (pinned at 0.3.0 by patch-package); paneToolbar.test.ts checks each one
   against the built TerminalPane, so a package change that renames one fails
   there instead of quietly dropping a menu item. */
export const PANE_TITLES = {
  /** Prefix: the full title goes on to describe links and paths. */
  select: 'Select terminal text',
  exitSelect: 'Exit select mode',
  reconnect: 'Reconnect to session',
  refresh: 'Refresh sessions',
  close: 'Close session',
} as const;

export const PANE_CONNECTION_PILL = 'connection-pill';
/** The package's toolbar, which holds every button below. */
export const PANE_TOOLBAR = '.terminal-toolbar';

export const SELECT = `.terminal-toolbar button[title^="${PANE_TITLES.select}"], .terminal-toolbar button[title="${PANE_TITLES.exitSelect}"]`;
export const RECONNECT = `.terminal-toolbar button[title="${PANE_TITLES.reconnect}"], .terminal-toolbar button[title="${PANE_TITLES.refresh}"]`;
export const CLOSE_SESSION = `.terminal-toolbar button[title="${PANE_TITLES.close}"]`;
