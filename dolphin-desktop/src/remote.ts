/* Remote machines: which helper bundle fits one, and what went wrong reaching
 * or setting it up, said plainly. No Electron here (test/remote.test.mjs). */

export type BundleKey = 'linux-x64' | 'linux-arm64' | 'darwin-x64' | 'darwin-arm64';
export type RemotePlatform = { ok: true; key: BundleKey } | { ok: false; message: string };

const SUPPORTED = "Dolphin's helper runs on 64-bit Linux (x86_64 or arm64) and macOS.";

/** Prints `musl` on musl-based systems (Alpine), `glibc` otherwise. */
export const LIBC_PROBE = 'if ls /lib/ld-musl-* >/dev/null 2>&1; then echo musl; else echo glibc; fi';

/** The bundle for a machine's `uname -sm` and libc, or why there is none. */
export function classifyRemote(target: string, uname: string, libc = 'glibc'): RemotePlatform {
  const [kernel = '', machine = ''] = uname.trim().split(/\s+/);
  const x64 = /^(x86_64|amd64)$/i.test(machine);
  const arm64 = /^(aarch64|arm64)$/i.test(machine);
  if (kernel === 'Darwin' && (x64 || arm64)) return { ok: true, key: arm64 ? 'darwin-arm64' : 'darwin-x64' };
  if (kernel === 'Linux') {
    if (/^arm/i.test(machine) && !arm64) return { ok: false, message: `${target} is 32-bit ARM (${machine}). ${SUPPORTED}` };
    if (/^i[3-6]86$/i.test(machine)) return { ok: false, message: `${target} is 32-bit x86 (${machine}). ${SUPPORTED}` };
    if (x64 || arm64) {
      if (libc.trim() === 'musl') return { ok: false, message: `${target} uses musl libc (Alpine and similar). Dolphin's helper needs glibc: use a Debian, Ubuntu or Fedora based machine or container.` };
      return { ok: true, key: arm64 ? 'linux-arm64' : 'linux-x64' };
    }
  }
  if (/^(FreeBSD|OpenBSD|NetBSD|DragonFly|SunOS)$/.test(kernel)) return { ok: false, message: `${target} runs ${kernel}, which Dolphin's helper does not support. ${SUPPORTED}` };
  return { ok: false, message: `Dolphin has no helper for this machine (${uname.trim() || 'unknown system'}). ${SUPPORTED}` };
}

/** The name `ssh-keygen -R` expects: bare for port 22, "[host]:port" otherwise. */
function knownHostsName(target: string): string {
  const rest = target.replace(/^ssh:\/\//, '').replace(/^[^@]*@/, '');
  const match = /^(.*):(\d+)$/.exec(rest);
  return match && match[2] !== '22' ? `"[${match[1]}]:${match[2]}"` : match ? match[1] : rest;
}

/** What went wrong reaching or setting up a machine, said plainly, with the raw text after it. */
export function explainRemoteError(target: string, error: unknown): string {
  const raw = (error instanceof Error ? error.message : String(error)).trim();
  const rules: [RegExp, string][] = [
    [/REMOTE HOST IDENTIFICATION HAS CHANGED/i, `${target}'s host key has changed since this computer last connected. If the machine was reinstalled, remove the old key with: ssh-keygen -R ${knownHostsName(target)}, then reconnect. If it was not, do not connect: someone may be intercepting the connection.`],
    [/Host key verification failed/i, `${target}'s host key was not accepted.`],
    [/No space left on device|Disk quota exceeded/i, `${target} is out of disk space. Free some space in its home folder, then reconnect.`],
    [/DOLPHIN_NO_XZ/, `${target} has no xz, which unpacks Dolphin's helper. Install it (Debian or Ubuntu: sudo apt install xz-utils; Fedora: sudo dnf install xz), then reconnect.`],
    [/DOLPHIN_BAD_CHECKSUM/, `Dolphin's helper arrived damaged on ${target}. Reconnect to send it again.`],
    [/DOLPHIN_NOEXEC/, `${target} does not allow running programs from its home folder (it is mounted noexec), so Dolphin's helper cannot start there.`],
    [/DOLPHIN_EXEC_FORMAT|Exec format error|cannot execute binary file/i, `Dolphin's helper cannot run on ${target}: it was built for a different processor.`],
    [/could not resolve hostname|name or service not known|nodename nor servname/i, `No machine named ${target} was found. Check the name, or use its IP address.`],
    [/connection refused/i, `${target} is reachable, but SSH isn't running there. On a Mac, turn on Remote Login in System Settings › General › Sharing.`],
    [/timed out|no route to host|network is unreachable/i, `${target} didn't answer. Check that it is on and reachable from here (same network, VPN or tailnet).`],
    [/permission denied/i, `${target} didn't accept your SSH key or password.`],
  ];
  const plain = rules.find(([pattern]) => pattern.test(raw))?.[1];
  return plain ? `${plain}\n\n${raw}` : raw;
}

/** The end of the remote helper's log, or a line saying there is none yet.
 *  Bounded in bytes as well as lines, so one huge line cannot flood the result. */
export function remoteLogScript(home: string, lines = 200): string {
  const count = Number.isFinite(lines) ? Math.max(1, Math.floor(lines)) : 200;
  return `f="${home}/logs/helper.log"; if [ -s "$f" ]; then tail -n ${count} "$f" | tail -c 65536; else echo "Dolphin's helper has not written a log on this machine yet."; fi`;
}

/** The error for a helper that did not start, quoting the end of its log
 *  (each line cut at 2000 characters, the whole at 8 KB). */
export function startFailureMessage(target: string, logTail: string): string {
  const quoted = logTail.trim().split('\n').map((line) => (line.length > 2000 ? `${line.slice(0, 2000)}…` : line)).join('\n').slice(-8192);
  return `Dolphin could not start on ${target}.${quoted ? `\n\nThe end of its log:\n${quoted}` : ''}`;
}

/** Where a machine's fetched log is saved, under the profile's remote-logs/. */
export function remoteLogName(target: string): string {
  return `${target.replace(/[^A-Za-z0-9._-]/g, '_')}-helper.log`;
}
