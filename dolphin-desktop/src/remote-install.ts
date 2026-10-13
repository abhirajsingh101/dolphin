/* Setting up the helper on a remote machine: the script that receives the
 * bundle on stdin and checks it, the one that removes old versions, and the
 * upload's progress text. `home` is interpolated into double quotes, so it may
 * be "$HOME/.dolphin-server" (expanded remotely) or contain spaces. No
 * Electron here (test/remote-install.test.mjs). */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

/** Receive the bundle on stdin, verify it, unpack it, and prove it runs. */
export function installScript(home: string, version: string, sha256: string): string {
  return [
    'set -e',
    `v="${home}/versions"`,
    `d="$v/${version}"`,
    'command -v xz >/dev/null 2>&1 || { echo DOLPHIN_NO_XZ >&2; exit 66; }',
    'mkdir -p "$v"',
    'rm -rf "$d.part" "$d.tar.xz"',
    // Whatever fails under set -e, leave no half-unpacked folder or upload.
    `trap 'rm -rf "$d.part" "$d.tar.xz"' EXIT`,
    'cat > "$d.tar.xz"',
    'if command -v sha256sum >/dev/null 2>&1; then sum=$(sha256sum < "$d.tar.xz" | cut -d" " -f1);',
    'elif command -v shasum >/dev/null 2>&1; then sum=$(shasum -a 256 < "$d.tar.xz" | cut -d" " -f1);',
    // Verification is skipped only when the remote has neither sha256sum nor
    // shasum (Linux coreutils and macOS each ship one); a damaged upload there
    // fails later, at the run check (exit 67).
    `else sum=${sha256}; fi`,
    `[ "$sum" = "${sha256}" ] || { rm -f "$d.tar.xz"; echo DOLPHIN_BAD_CHECKSUM >&2; exit 65; }`,
    'mkdir -p "$d.part"',
    'xz -dc < "$d.tar.xz" | tar -x -C "$d.part"',
    'rm -f "$d.tar.xz"',
    'out=$("$d.part/dolphin-helper/dolphin-helper" version 2>&1) || {',
    '  rm -rf "$d.part"',
    '  case "$out" in *"xec format"*|*"cannot execute binary"*) echo "DOLPHIN_EXEC_FORMAT $out" >&2;; *) echo "DOLPHIN_NOEXEC $out" >&2;; esac',
    '  exit 67',
    '}',
    'rm -rf "$d"',
    'mv "$d.part" "$d"',
    'trap - EXIT',
  ].join('\n');
}

/** Remove helper versions other than `keep` and the newest other one. */
export function pruneScript(home: string, keep: string): string {
  // With three or more versions this may remove an older one that another app
  // instance on this machine is still running; that instance keeps its open
  // files but cannot restart that version.
  return [
    `cd "${home}/versions" 2>/dev/null || exit 0`,
    `ls -1t | grep -E '^[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z.-]+)?$' | grep -v -x -F "${keep}" | tail -n +2 | while IFS= read -r old; do rm -rf -- "./$old"; done`,
  ].join('\n');
}

const MB = 1024 * 1024;

/** "23/57 MB": whole megabytes sent, of the total rounded up. */
export function formatProgress(sent: number, total: number): string {
  const all = Math.max(1, Math.ceil(total / MB));
  const done = sent >= total ? all : Math.floor(sent / MB);
  return `${done}/${all} MB`;
}

export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file).on('data', (chunk) => hash.update(chunk)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
  });
}
