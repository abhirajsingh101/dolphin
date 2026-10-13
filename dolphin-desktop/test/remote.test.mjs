// Which machines Dolphin's helper runs on, and what went wrong, in plain words.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { classifyRemote, explainRemoteError, LIBC_PROBE, remoteLogName, remoteLogScript, startFailureMessage } from '../dist/remote.js';

test('64-bit Linux and macOS get their bundle', () => {
  assert.deepEqual(classifyRemote('gpu', 'Linux x86_64', 'glibc'), { ok: true, key: 'linux-x64' });
  assert.deepEqual(classifyRemote('gpu', 'Linux amd64'), { ok: true, key: 'linux-x64' });
  assert.deepEqual(classifyRemote('pi', 'Linux aarch64', 'glibc'), { ok: true, key: 'linux-arm64' });
  assert.deepEqual(classifyRemote('mac', 'Darwin arm64'), { ok: true, key: 'darwin-arm64' });
  assert.deepEqual(classifyRemote('mac', 'Darwin x86_64'), { ok: true, key: 'darwin-x64' });
});

test('anything else is refused with a reason, never sent the wrong binary', () => {
  const refused = (uname, libc, pattern) => {
    const result = classifyRemote('box', uname, libc);
    assert.equal(result.ok, false, uname);
    assert.match(result.message, pattern);
  };
  refused('Linux armv7l', 'glibc', /box is 32-bit ARM \(armv7l\)\. Dolphin's helper runs on 64-bit Linux \(x86_64 or arm64\) and macOS\./);
  refused('Linux armv6l', 'glibc', /32-bit ARM/);
  refused('Linux i686', 'glibc', /32-bit x86 \(i686\)/);
  refused('Linux x86_64', 'musl', /box uses musl libc \(Alpine and similar\)\. Dolphin's helper needs glibc/);
  refused('FreeBSD amd64', 'glibc', /box runs FreeBSD, which Dolphin's helper does not support/);
  refused('OpenBSD amd64', undefined, /OpenBSD/);
  refused('', undefined, /Dolphin has no helper for this machine/);
});

test('the libc probe runs in sh and says glibc or musl', () => {
  assert.match(execFileSync('sh', ['-c', LIBC_PROBE], { encoding: 'utf8' }).trim(), /^(glibc|musl)$/);
});

test('ssh and install failures are said plainly, with the raw text kept', () => {
  const says = (raw, pattern) => {
    const text = explainRemoteError('gpu-box', new Error(raw));
    assert.match(text, pattern, raw);
    assert.ok(text.endsWith(raw), 'the raw text follows');
  };
  says('@@@@@@@@@@@\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\nHost key verification failed.', /^gpu-box's host key has changed since this computer last connected\..*ssh-keygen -R gpu-box/s);
  const changed = '@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @';
  assert.match(explainRemoteError('me@192.0.2.7:2222', new Error(changed)), /ssh-keygen -R "\[192\.0\.2\.7\]:2222",/);
  assert.match(explainRemoteError('ssh://me@example.com:2222', new Error(changed)), /ssh-keygen -R "\[example\.com\]:2222",/);
  assert.match(explainRemoteError('me@example.com', new Error(changed)), /ssh-keygen -R example\.com,/);
  says('Host key verification failed.', /^gpu-box's host key was not accepted\./);
  says('mkdir: cannot create directory: No space left on device', /^gpu-box is out of disk space/);
  says('Disk quota exceeded', /out of disk space/);
  says('DOLPHIN_NO_XZ', /^gpu-box has no xz, which unpacks Dolphin's helper\. Install it \(Debian or Ubuntu: sudo apt install xz-utils; Fedora: sudo dnf install xz\), then reconnect\./);
  says('DOLPHIN_BAD_CHECKSUM', /^Dolphin's helper arrived damaged on gpu-box/);
  says('DOLPHIN_NOEXEC sh: 1: Permission denied', /^gpu-box does not allow running programs from its home folder \(it is mounted noexec\)/);
  says('DOLPHIN_EXEC_FORMAT cannot execute binary file: Exec format error', /^Dolphin's helper cannot run on gpu-box: it was built for a different processor\./);
  says('ssh: Could not resolve hostname gpu-box: Name or service not known', /^No machine named gpu-box was found/);
  says('ssh: connect to host gpu-box port 22: Connection refused', /SSH isn't running there/);
  says('ssh: connect to host gpu-box port 22: Operation timed out', /didn't answer/);
  says('Permission denied (publickey,password).', /didn't accept your SSH key or password/);
  assert.equal(explainRemoteError('gpu-box', new Error('something new')), 'something new');
});

test('the remote log script prints the tail, or says there is no log yet', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'drlog-'));
  try {
    const home = path.join(dir, 'Shared Work', '.dolphin-server');
    assert.equal(execFileSync('/bin/sh', ['-c', remoteLogScript(home, 2)], { encoding: 'utf8' }).trim(), "Dolphin's helper has not written a log on this machine yet.");
    mkdirSync(path.join(home, 'logs'), { recursive: true });
    writeFileSync(path.join(home, 'logs', 'helper.log'), 'one\ntwo\nthree\n');
    assert.equal(execFileSync('/bin/sh', ['-c', remoteLogScript(home, 2)], { encoding: 'utf8' }), 'two\nthree\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('remote log files are named after the machine, safely', () => {
  assert.equal(remoteLogName('gpu-box'), 'gpu-box-helper.log');
  assert.equal(remoteLogName('ssh://me@host:2222'), 'ssh___me_host_2222-helper.log');
});

test('one huge log line cannot flood the output, and a bad line count falls back', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'drlog-'));
  try {
    mkdirSync(path.join(dir, 'logs'), { recursive: true });
    writeFileSync(path.join(dir, 'logs', 'helper.log'), `${'x'.repeat(500_000)}\nlast\n`);
    const out = execFileSync('/bin/sh', ['-c', remoteLogScript(dir, 5)], { encoding: 'utf8' });
    assert.ok(out.length <= 65_536, `${out.length} bytes`);
    assert.ok(out.endsWith('last\n'));
    assert.match(remoteLogScript(dir, Number.NaN), /tail -n 200 /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a start failure quotes the end of the log, bounded', () => {
  assert.equal(startFailureMessage('gpu', ''), 'Dolphin could not start on gpu.');
  assert.equal(startFailureMessage('gpu', ' boom\n'), 'Dolphin could not start on gpu.\n\nThe end of its log:\nboom');
  const long = startFailureMessage('gpu', `${'y'.repeat(5000)}\n${'z\n'.repeat(10_000)}`);
  assert.ok(long.length < 8_400, `${long.length} chars`);
  assert.ok(!long.includes('y'.repeat(2_001)));
});
