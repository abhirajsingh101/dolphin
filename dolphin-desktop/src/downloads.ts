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
