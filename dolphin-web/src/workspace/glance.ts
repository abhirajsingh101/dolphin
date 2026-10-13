/* Hover glance (spec item 12): the last lines of a tmux snapshot while the
   pointer rests on a session row or the row has keyboard focus. Read-only;
   it is a snapshot, no terminal socket opens. */

export const GLANCE_DELAY_MS = 600;
export const GLANCE_LINES = 8;
export const GLANCE_REFRESH_MS = 2000;

// CSI, OSC (BEL or ST terminated) and two-byte escapes; then any remaining control characters.
const ESCAPES = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[@-Z\\-_]/g;
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

export function lastLines(content: string, count = GLANCE_LINES): string[] {
  const rows = content.replace(ESCAPES, '').split(/\r?\n/)
    .map((line) => line.replace(CONTROLS, '').replace(/\s+$/, ''));
  while (rows.length && rows[rows.length - 1] === '') rows.pop();
  return rows.slice(-count);
}
