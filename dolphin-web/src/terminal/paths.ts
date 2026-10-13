import { extractPathCandidates, pathCandidateBatches } from '@dolphin-terminal/core';
import type { TerminalPathResolution } from '@dolphin-terminal/protocol';
import type { IBufferLine, ILink, ILinkProvider, Terminal } from '@xterm/xterm';

import { isLinkActivation } from './linkActions';

/* path:line links in the live terminal. The shared tokenizer finds the
   candidates, the server says which are files (as in select mode), and only
   those become links. */

/** A path that was not a file is asked about again after this long. */
export const MISSING_PATH_RETRY_MS = 10_000;

/** Answers remembered per terminal; the oldest is forgotten first. */
export const MAX_PATH_CACHE = 2000;

export type PathResolver = (candidates: string[]) => Promise<Map<string, string>>;

export function createPathResolver(
  resolve: (candidates: string[]) => Promise<TerminalPathResolution[]>,
  now: () => number = () => Date.now(),
): PathResolver {
  /* Oldest first (Map keeps insertion order). `path` is null for a candidate
     that was missing or whose request failed; that answer expires. */
  const known = new Map<string, { path: string | null; at: number }>();
  const inflight = new Map<string, Promise<void>>();
  const remember = (candidate: string, path: string | null) => {
    known.delete(candidate);
    known.set(candidate, { path, at: now() });
    while (known.size > MAX_PATH_CACHE) known.delete(known.keys().next().value as string);
  };
  const ask = async (batch: string[]) => {
    try {
      const answered = new Set<string>();
      for (const item of await resolve(batch)) {
        answered.add(item.candidate);
        remember(item.candidate, item.kind === 'file' && item.path ? item.path : null);
      }
      for (const candidate of batch) if (!answered.has(candidate)) remember(candidate, null);
    } catch {
      for (const candidate of batch) remember(candidate, null); // back off, not a retry per hover
    }
  };
  return async (candidates) => {
    const waits: Promise<void>[] = [];
    const unknown: string[] = [];
    for (const candidate of new Set(candidates)) {
      const entry = known.get(candidate);
      if (entry && (entry.path || entry.at + MISSING_PATH_RETRY_MS > now())) continue;
      if (entry) known.delete(candidate);
      const pending = inflight.get(candidate);
      if (pending) waits.push(pending);
      else unknown.push(candidate);
    }
    for (const batch of pathCandidateBatches(unknown)) {
      const request = ask(batch).finally(() => { for (const candidate of batch) inflight.delete(candidate); });
      for (const candidate of batch) inflight.set(candidate, request);
      waits.push(request);
    }
    await Promise.all(waits);
    const result = new Map<string, string>();
    for (const candidate of candidates) {
      const path = known.get(candidate)?.path;
      if (path) result.set(candidate, path);
    }
    return result;
  };
}

/** A row's text, and the cell each UTF-16 offset of it sits in. */
export function lineText(line: IBufferLine, cols: number): { text: string; columns: number[] } {
  let text = '';
  const columns: number[] = [];
  for (let x = 0; x < cols; x += 1) {
    const cell = line.getCell(x);
    if (!cell) break;
    if (cell.getWidth() === 0) continue; // the right half of a wide character
    const chars = cell.getChars() || ' ';
    text += chars;
    for (let i = 0; i < chars.length; i += 1) columns.push(x);
  }
  const trimmed = text.replace(/\s+$/u, '');
  return { text: trimmed, columns: columns.slice(0, trimmed.length) };
}

export function createPathLinkProvider(
  terminal: Terminal,
  deps: { resolve: PathResolver; mac: boolean; openFile(path: string): void },
): ILinkProvider {
  return {
    provideLinks(y, callback) {
      const line = terminal.buffer.active.getLine(y - 1);
      if (!line) {
        callback(undefined);
        return;
      }
      const { text, columns } = lineText(line, terminal.cols);
      const candidates = extractPathCandidates(text);
      if (candidates.length === 0) {
        callback(undefined);
        return;
      }
      deps.resolve(candidates.map((candidate) => candidate.lookup)).then((files) => {
        const links: ILink[] = [];
        let cursor = 0;
        // Widest first at each offset; the first confirmed one wins.
        for (const candidate of candidates) {
          if (candidate.start < cursor) continue;
          const path = files.get(candidate.lookup);
          if (!path) continue;
          cursor = candidate.end;
          links.push({
            text: candidate.raw,
            range: {
              start: { x: columns[candidate.start] + 1, y },
              end: { x: columns[candidate.end - 1] + 1, y },
            },
            decorations: { pointerCursor: true, underline: true },
            activate: (event) => {
              if (isLinkActivation(event, deps.mac)) deps.openFile(path);
            },
          });
        }
        callback(links.length > 0 ? links : undefined);
      }, () => callback(undefined));
    },
  };
}

export function attachPathLinks(
  terminal: Terminal,
  deps: { resolve: PathResolver; mac: boolean; openFile(path: string): void },
): () => void {
  const registration = terminal.registerLinkProvider(createPathLinkProvider(terminal, deps));
  return () => registration.dispose();
}
