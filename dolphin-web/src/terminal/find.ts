/* Find over a tmux snapshot. Under tmux the browser's xterm is on the
   alternate screen and keeps no history, so the snapshot is what holds it. */

export const FIND_SNAPSHOT_LINES = 10_000;
export const MAX_FIND_MATCHES = 1000;

export type FindMatch = { start: number; end: number };
export type FindSegment = { text: string; match: number | null };

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* A RegExp rather than lowercasing both strings: toLowerCase can change a
   string's length ("İ"), which would shift every offset after it. */
export function findMatches(text: string, query: string, options: { caseSensitive?: boolean } = {}): FindMatch[] {
  if (!query) return [];
  const pattern = new RegExp(escapeRegExp(query), options.caseSensitive ? 'gu' : 'giu');
  const matches: FindMatch[] = [];
  for (const match of text.matchAll(pattern)) {
    if (matches.length >= MAX_FIND_MATCHES) break;
    matches.push({ start: match.index, end: match.index + match[0].length });
  }
  return matches;
}

export function findSegments(text: string, matches: FindMatch[]): FindSegment[] {
  const segments: FindSegment[] = [];
  let cursor = 0;
  matches.forEach((match, index) => {
    if (match.start > cursor) segments.push({ text: text.slice(cursor, match.start), match: null });
    segments.push({ text: text.slice(match.start, match.end), match: index });
    cursor = match.end;
  });
  if (cursor < text.length) segments.push({ text: text.slice(cursor), match: null });
  return segments;
}

export function stepMatch(active: number, total: number, direction: 1 | -1): number {
  return total === 0 ? 0 : (active + direction + total) % total;
}

export function findCountLabel(active: number, total: number, query: string): string {
  if (!query) return '';
  if (total === 0) return 'No matches';
  return `${active + 1} of ${total}${total >= MAX_FIND_MATCHES ? '+' : ''}`;
}

/** The active index kept inside the matches, so a stale one never shows. */
export function clampActive(active: number, total: number): number {
  return Math.min(Math.max(active, 0), Math.max(total - 1, 0));
}
