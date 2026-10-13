// The Mac update feed the release job writes for both architectures, as
// electron-updater's MacUpdater reads it (it picks the zip whose name says arm64
// on Apple Silicon, and the other one on Intel).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { feedName, macFeed } from '../scripts/mac-update-feed.mjs';
import { expectedInstallers, expectedUpdateFiles } from '../scripts/check-artifacts.mjs';
import { updateFilesChannel } from '../dist/releases.js';

const script = path.resolve(import.meta.dirname, '..', 'scripts', 'mac-update-feed.mjs');

test('one feed lists both architectures\' zips', () => {
  const feed = macFeed('0.2.0', [
    { name: 'Dolphin-0.2.0-mac-x64.zip', sha512: 'X', size: 2 },
    { name: 'Dolphin-0.2.0-mac-arm64.zip', sha512: 'A', size: 1 },
    { name: 'Dolphin-0.2.0-mac-arm64.dmg', sha512: 'D', size: 9 },
  ], '2026-10-12T00:00:00.000Z');
  assert.equal(feed, [
    'version: 0.2.0', 'files:',
    '  - url: Dolphin-0.2.0-mac-arm64.zip', '    sha512: A', '    size: 1',
    '  - url: Dolphin-0.2.0-mac-x64.zip', '    sha512: X', '    size: 2',
    'path: Dolphin-0.2.0-mac-x64.zip', 'sha512: X', "releaseDate: '2026-10-12T00:00:00.000Z'", '',
  ].join('\n'));
  assert.equal(macFeed('0.2.0', [], 'now'), null);
  assert.equal(feedName('0.2.0'), 'latest-mac.yml');
  assert.equal(feedName('0.2.1-beta.2'), 'beta-mac.yml');
});

test('the script hashes this release\'s zips and ignores others', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dfeed-'));
  try {
    writeFileSync(path.join(dir, 'Dolphin-0.2.1-beta.1-mac-arm64.zip'), 'arm');
    writeFileSync(path.join(dir, 'Dolphin-0.2.1-beta.1-mac-x64.zip'), 'intel');
    writeFileSync(path.join(dir, 'Dolphin-0.2.0-mac-x64.zip'), 'old');
    execFileSync(process.execPath, [script, dir, '0.2.1-beta.1']);
    const feed = readFileSync(path.join(dir, 'beta-mac.yml'), 'utf8');
    assert.match(feed, new RegExp(`sha512: ${createHash('sha512').update('arm').digest('base64').replace(/[+/]/g, '\\$&')}`));
    assert.match(feed, /size: 5/);
    assert.doesNotMatch(feed, /Dolphin-0\.2\.0-/);
    assert.equal(existsSync(path.join(dir, 'latest-mac.yml')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the feed agrees with the build: its zips are the build\'s zips, its name is the updater\'s channel file', () => {
  for (const version of ['0.2.0', '0.2.1-beta.1']) {
    const zips = ['darwin-arm64', 'darwin-x64'].flatMap((target) => expectedInstallers(version, target)).filter((name) => name.endsWith('.zip'));
    const feed = macFeed(version, zips.map((name) => ({ name, sha512: 'S', size: 1 })), 'now');
    for (const zip of zips) assert.match(feed, new RegExp(`url: ${zip.replace(/\./g, '\\.')}\\n`));
    assert.equal(feedName(version), `${updateFilesChannel(version)}-mac.yml`);
    assert.deepEqual(expectedUpdateFiles(version, 'darwin-arm64'), [], 'the build leaves the Mac feed to the release job');
  }
});
