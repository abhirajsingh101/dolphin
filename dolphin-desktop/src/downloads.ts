/* Where a file downloaded from a machine lands on this computer: the
 * Downloads folder, under the name the machine gave it, with " (1)", " (2)"…
 * before the extension when that name is taken. No Electron here
 * (test/downloads.test.mjs). */

import path from 'node:path';

/** A name safe on every OS: no folders, no characters Windows refuses. */
export function safeFileName(suggested: string): string {
  const name = path.basename(suggested.replace(/[\\/]/g, '_'))
    .replace(/[<>:"|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/, '');
  return name && name !== '..' ? name : 'download';
}

/** The first free path in `dir` for `suggested`, by `taken`. */
export function downloadPath(dir: string, suggested: string, taken: (file: string) => boolean): string {
  const name = safeFileName(suggested);
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 0; n < 1000; n += 1) {
    const file = path.join(dir, n === 0 ? name : `${stem} (${n})${ext}`);
    if (!taken(file)) return file;
  }
  return path.join(dir, `${stem} (${Date.now()})${ext}`);
}

/** One download, as the windows show it (the page's DownloadsControl). */
export type Download = {
  id: string;
  name: string;
  /** Where it is saved on this computer. */
  file: string;
  /** The machine it came from, when a terminal path asked for it. */
  machine?: string;
  received: number;
  /** 0 when the machine did not say. */
  total: number;
  state: 'progressing' | 'completed' | 'cancelled' | 'failed';
  error?: string;
  started: number;
};

/** The downloads list keeps this many; the oldest finished ones go first. */
export const KEEP_DOWNLOADS = 20;

/** Newest first, at most `keep`, never dropping one still in progress. */
export function keepRecent(list: Download[], keep = KEEP_DOWNLOADS): Download[] {
  const sorted = [...list].sort((a, b) => b.started - a.started);
  let extra = sorted.length - keep;
  for (let index = sorted.length - 1; index >= 0 && extra > 0; index -= 1) {
    if (sorted[index].state !== 'progressing') { sorted.splice(index, 1); extra -= 1; }
  }
  return sorted;
}

/** What a download that did not complete says. */
export function downloadFailure(state: 'cancelled' | 'interrupted', machine?: string): string {
  if (state === 'cancelled') return 'Cancelled';
  return machine ? `Stopped: check that ${machine} is still connected, then click the path again.` : 'Stopped before it finished.';
}
