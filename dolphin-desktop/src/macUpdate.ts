/* In-place updates for a Mac app without a Developer ID.
 *
 * electron-updater installs into a Mac app only when it is Developer ID
 * signed (Squirrel.Mac checks the new app's signature against the running
 * one's). Dolphin's Mac builds are ad-hoc signed, so updates.ts does the same
 * job here, the way a signed build would look to the user: the release's zip
 * downloads in the background, checked against the SHA-512 in its
 * latest-mac.yml; it is unpacked with ditto, and its signature and version
 * are checked. Restart to Update (or quitting) runs a small script that waits
 * for Dolphin to quit, swaps the app bundle and opens it again; a swap that
 * fails puts the old app back.
 *
 * An app macOS runs from the disk image or from a translocated copy, or in a
 * folder the user cannot write, is not replaced: it offers the download, as
 * before (inPlaceBlocker). */

import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, createWriteStream, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import path from 'node:path';
import { promisify } from 'node:util';

export type MacFeedFile = { url: string; sha512: string; size: number };

/** The zips a latest-mac.yml (scripts/mac-update-feed.mjs) lists, each with
 *  its checksum and size. Anything else in it, or a file that is not a feed,
 *  gives nothing. */
export function parseMacFeed(text: string): MacFeedFile[] {
  const files: MacFeedFile[] = [];
  let entry: Partial<MacFeedFile> | null = null;
  let inFiles = false;
  const keep = () => {
    if (entry?.url && entry.sha512 && Number.isInteger(entry.size)) files.push(entry as MacFeedFile);
    entry = null;
  };
  for (const line of text.split(/\r?\n/)) {
    if (/^\S/.test(line)) { keep(); inFiles = line.trim() === 'files:'; continue; }
    if (!inFiles) continue;
    const item = /^\s*-\s+(\w+):\s*(.+?)\s*$/.exec(line);
    const field = item ?? /^\s+(\w+):\s*(.+?)\s*$/.exec(line);
    if (!field) continue;
    if (item) { keep(); entry = {}; }
    if (!entry) continue;
    const [, key, value] = field;
    if (key === 'url') entry.url = value;
    else if (key === 'sha512') entry.sha512 = value;
    else if (key === 'size') entry.size = Number(value);
  }
  keep();
  return files;
}

/** This Mac's zip: Dolphin-<version>-mac-<arch>.zip. */
export function macZipFor(files: MacFeedFile[], arch: string): MacFeedFile | undefined {
  return files.find((file) => file.url.endsWith(`-mac-${arch}.zip`));
}

/** The .app bundle the running executable belongs to, or null. */
export function appBundleOf(execPath: string): string | null {
  return /^(.+\.app)\/Contents\/MacOS\/[^/]+$/.exec(execPath)?.[1] ?? null;
}

/** Why this app cannot replace itself, or null when it can. */
export function inPlaceBlocker(bundle: string): string | null {
  if (bundle.startsWith('/Volumes/')) return 'Dolphin is running from its disk image. Drag it to Applications to update it in place.';
  if (bundle.includes('/AppTranslocation/')) return 'macOS is running a temporary copy of Dolphin. Move Dolphin to Applications to update it in place.';
  try {
    accessSync(path.dirname(bundle), constants.W_OK);
    accessSync(bundle, constants.W_OK);
  } catch {
    return `Dolphin has no permission to replace itself in ${path.dirname(bundle)}.`;
  }
  return null;
}

type Fetch = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

/** Download `file` to `dest`, keeping it only when its size and SHA-512 match
 *  the feed. `onProgress` hears whole percents, 100 last. */
export async function downloadVerified(file: MacFeedFile, dest: string, o: { fetch: Fetch; signal?: AbortSignal; onProgress?: (percent: number) => void }): Promise<void> {
  const response = await o.fetch(file.url, { signal: o.signal });
  if (!response.ok || !response.body) throw new Error(`the download answered ${response.status}`);
  mkdirSync(path.dirname(dest), { recursive: true });
  const partial = `${dest}.part`;
  const out = createWriteStream(partial);
  const hash = createHash('sha512');
  let received = 0;
  let reported = -1;
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      hash.update(chunk);
      received += chunk.length;
      if (!out.write(chunk)) await once(out, 'drain');
      const percent = Math.min(99, Math.floor((received * 100) / file.size));
      if (percent > reported) { reported = percent; o.onProgress?.(percent); }
    }
    await new Promise<void>((resolve, reject) => out.end((error?: Error | null) => (error ? reject(error) : resolve())));
    if (received !== file.size) throw new Error(`the download's size is ${received} bytes, not the release's ${file.size}`);
    if (hash.digest('base64') !== file.sha512) throw new Error("the download's checksum does not match the release's");
    renameSync(partial, dest);
    o.onProgress?.(100);
  } catch (error) {
    out.destroy();
    rmSync(partial, { force: true });
    throw error;
  }
}

const run = promisify(execFile);

/** Unpack the downloaded zip into `dir` and check what is in it: one app, its
 *  signature intact, of the version the release says. Returns the app's path. */
export async function unpackUpdate(zip: string, dir: string, version: string): Promise<string> {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  // ditto keeps the bundle's symlinks, permissions and signature as they were zipped.
  await run('/usr/bin/ditto', ['-x', '-k', zip, dir]);
  const apps = readdirSync(dir).filter((name) => name.endsWith('.app'));
  if (apps.length !== 1) throw new Error('the update does not hold one app');
  const bundle = path.join(dir, apps[0]);
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  const { stdout } = await run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', path.join(bundle, 'Contents', 'Info.plist')]);
  if (stdout.trim() !== version) throw new Error(`the update is version ${stdout.trim()}, not ${version}`);
  return bundle;
}

const SWAP_SCRIPT = `#!/bin/sh
# Dolphin's in-place update (macUpdate.ts): wait for Dolphin (pid $1) to quit,
# put the new app ($3) where the old one is ($2), keeping the old one aside
# until the new one is in place, and open it again when $4 is 1. A swap that
# fails puts the old app back, and that one opens.
pid="$1"; current="$2"; staged="$3"; relaunch="$4"
backup="$(dirname "$current")/.$(basename "$current" .app)-replaced.app"
tries=0
while kill -0 "$pid" 2>/dev/null; do
  tries=$((tries + 1))
  if [ "$tries" -gt 600 ]; then exit 3; fi
  sleep 0.1
done
status=0
rm -rf "$backup"
if mv "$current" "$backup"; then
  if mv "$staged" "$current"; then
    rm -rf "$backup"
  else
    status=1
    mv "$backup" "$current"
  fi
else
  status=2
fi
if [ "$relaunch" = 1 ]; then open "$current"; fi
exit "$status"
`;

/** The swap script, written into `dir`. Returns its path. */
export function writeSwapScript(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'swap.sh');
  writeFileSync(file, SWAP_SCRIPT, { mode: 0o755 });
  return file;
}

/** Start the swap; it outlives Dolphin, which should quit next. */
export function startSwap(o: { dir: string; pid: number; current: string; staged: string; relaunch: boolean }): void {
  const script = writeSwapScript(o.dir);
  const child = spawn('/bin/sh', [script, String(o.pid), o.current, o.staged, o.relaunch ? '1' : '0'], { detached: true, stdio: 'ignore' });
  child.unref();
}
