// A Mac app without a Developer ID updates itself in place (src/macUpdate.ts):
// it downloads the release's zip, checks it against the feed's SHA-512, and,
// once Dolphin has quit, a small script swaps the app bundle and opens it
// again. These parts run anywhere; mac-update.test.mjs runs the whole update
// on a Mac.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appBundleOf, downloadVerified, inPlaceBlocker, macZipFor, parseMacFeed, writeSwapScript } from '../dist/macUpdate.js';

const FEED = `version: 0.2.3
files:
  - url: Dolphin-0.2.3-mac-arm64.zip
    sha512: IJLzVpV+Vb5DJ4XByYeTTxKXG9LK1uuLj40eKg9e0Jq1D+z/fSu9PLNmWEkJr8c+qyiF+rmgCRCzOZ7Fn1v87A==
    size: 253584014
  - url: Dolphin-0.2.3-mac-x64.zip
    sha512: 5rcXFcbNu+ErgGosP6GFMmWJ+hA7/5Ixo46Feqli9EN5Cwvy6uqHFAFx6T+o3vI5m37HSzDvLvfqC6Umk1M4AA==
    size: 260693087
path: Dolphin-0.2.3-mac-x64.zip
sha512: 5rcXFcbNu+ErgGosP6GFMmWJ+hA7/5Ixo46Feqli9EN5Cwvy6uqHFAFx6T+o3vI5m37HSzDvLvfqC6Umk1M4AA==
releaseDate: '2026-10-14T09:46:03.119Z'
`;

test('the feed lists each zip with its checksum and size, and each Mac takes its own', () => {
  const files = parseMacFeed(FEED);
  assert.deepEqual(files.map((file) => [file.url, file.size]), [['Dolphin-0.2.3-mac-arm64.zip', 253584014], ['Dolphin-0.2.3-mac-x64.zip', 260693087]]);
  assert.equal(files[0].sha512, 'IJLzVpV+Vb5DJ4XByYeTTxKXG9LK1uuLj40eKg9e0Jq1D+z/fSu9PLNmWEkJr8c+qyiF+rmgCRCzOZ7Fn1v87A==');
  assert.equal(macZipFor(files, 'arm64')?.url, 'Dolphin-0.2.3-mac-arm64.zip');
  assert.equal(macZipFor(files, 'x64')?.url, 'Dolphin-0.2.3-mac-x64.zip');
  assert.equal(macZipFor(files, 'ia32'), undefined);
  // A feed that lists nothing usable, or is not a feed at all.
  assert.deepEqual(parseMacFeed('version: 1\nfiles:\n  - url: x.zip\n'), []);
  assert.deepEqual(parseMacFeed('<html>Not found</html>'), []);
});

test('the app bundle is found from the running executable', () => {
  assert.equal(appBundleOf('/Applications/Dolphin.app/Contents/MacOS/Dolphin'), '/Applications/Dolphin.app');
  assert.equal(appBundleOf('/Users/me/Apps/Dolphin Beta.app/Contents/MacOS/Dolphin'), '/Users/me/Apps/Dolphin Beta.app');
  assert.equal(appBundleOf('/usr/lib/electron/electron'), null);
});

test('an app on the disk image, translocated, or in a folder it cannot write is not replaced', () => {
  assert.match(inPlaceBlocker('/Volumes/Dolphin 0.2.3-arm64/Dolphin.app'), /disk image/);
  assert.match(inPlaceBlocker('/private/var/folders/x1/T/AppTranslocation/0A1B/d/Dolphin.app'), /Applications/);
  const dir = mkdtempSync(path.join(tmpdir(), 'dinplace-'));
  try {
    const bundle = path.join(dir, 'Dolphin.app');
    mkdirSync(bundle);
    assert.equal(inPlaceBlocker(bundle), null);
    chmodSync(dir, 0o555);
    if (process.getuid?.() !== 0) assert.match(inPlaceBlocker(bundle), /permission/);
  } finally {
    chmodSync(dir, 0o755);
    rmSync(dir, { recursive: true, force: true });
  }
});

async function serve(body) {
  const server = createServer((_request, response) => {
    response.setHeader('Content-Length', String(body.length));
    // In pieces, so progress has steps.
    const half = Math.floor(body.length / 2);
    response.write(body.subarray(0, half));
    setTimeout(() => response.end(body.subarray(half)), 20);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}/Dolphin.zip`, close: () => server.close() };
}

test('a download is kept only when its checksum and size match the feed', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dinplace-'));
  const body = Buffer.alloc(300_000, 7);
  const sha512 = createHash('sha512').update(body).digest('base64');
  const server = await serve(body);
  try {
    const file = path.join(dir, 'Dolphin.zip');
    const progress = [];
    await downloadVerified({ url: server.url, sha512, size: body.length }, file, { fetch, onProgress: (percent) => progress.push(percent) });
    assert.deepEqual(readFileSync(file), body);
    assert.equal(progress.at(-1), 100);
    assert.ok(progress.every((value, index) => index === 0 || value >= progress[index - 1]), `progress only grows: ${progress}`);

    const bad = path.join(dir, 'bad.zip');
    await assert.rejects(downloadVerified({ url: server.url, sha512: createHash('sha512').update('other').digest('base64'), size: body.length }, bad, { fetch }), /checksum/);
    assert.equal(existsSync(bad), false, 'a download that fails its check is deleted');
    await assert.rejects(downloadVerified({ url: server.url, sha512, size: body.length + 1 }, bad, { fetch }), /size/);
    assert.equal(existsSync(bad), false);
    await assert.rejects(downloadVerified({ url: server.url.replace(/\d+\/Dolphin/, '1/Dolphin'), sha512, size: body.length }, bad, { fetch }));
    assert.equal(existsSync(bad), false);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A pretend Mac: an installed app, an unpacked update, and an `open` that writes down what it opened. */
function pretendMac() {
  const dir = mkdtempSync(path.join(tmpdir(), 'dswap-'));
  const apps = path.join(dir, 'Applications');
  const current = path.join(apps, 'Dolphin.app');
  const staged = path.join(dir, 'update', 'Dolphin.app');
  mkdirSync(current, { recursive: true });
  mkdirSync(staged, { recursive: true });
  writeFileSync(path.join(current, 'version'), 'old');
  writeFileSync(path.join(staged, 'version'), 'new');
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  const opened = path.join(dir, 'opened');
  writeFileSync(path.join(bin, 'open'), `#!/bin/sh\necho "$@" >> "${opened}"\n`, { mode: 0o755 });
  const script = writeSwapScript(path.join(dir, 'update'));
  const run = (pid, relaunch) => new Promise((resolve) => {
    const child = spawn('/bin/sh', [script, String(pid), current, staged, relaunch ? '1' : '0'], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    child.on('exit', (code) => resolve(code));
  });
  return { dir, apps, current, staged, opened, run };
}

test('once Dolphin has quit, the script swaps in the new app and opens it', async () => {
  const mac = pretendMac();
  try {
    // Stands in for Dolphin, quitting a moment later.
    const dolphin = spawn('sleep', ['1']);
    const started = Date.now();
    const code = await mac.run(dolphin.pid, true);
    assert.equal(code, 0);
    assert.ok(Date.now() - started >= 800, 'the script waited for Dolphin to quit');
    assert.equal(readFileSync(path.join(mac.current, 'version'), 'utf8'), 'new');
    assert.deepEqual(readdirSync(mac.apps), ['Dolphin.app'], 'no backup is left behind');
    assert.equal(existsSync(mac.staged), false);
    assert.equal(readFileSync(mac.opened, 'utf8').trim(), mac.current);
  } finally {
    rmSync(mac.dir, { recursive: true, force: true });
  }
});

test('installing on quit swaps the app without opening it', async () => {
  const mac = pretendMac();
  try {
    assert.equal(await mac.run(999_999_999, false), 0);
    assert.equal(readFileSync(path.join(mac.current, 'version'), 'utf8'), 'new');
    assert.equal(existsSync(mac.opened), false);
  } finally {
    rmSync(mac.dir, { recursive: true, force: true });
  }
});

test('a swap that fails puts the old app back and still opens it', async () => {
  const mac = pretendMac();
  try {
    rmSync(mac.staged, { recursive: true });
    assert.notEqual(await mac.run(999_999_999, true), 0);
    assert.equal(readFileSync(path.join(mac.current, 'version'), 'utf8'), 'old');
    assert.deepEqual(readdirSync(mac.apps), ['Dolphin.app']);
    assert.equal(readFileSync(mac.opened, 'utf8').trim(), mac.current);
  } finally {
    rmSync(mac.dir, { recursive: true, force: true });
  }
});
