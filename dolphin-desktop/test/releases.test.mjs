// Which release is newer, and which installer fits which machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installerFor, isNewer, releaseVersion } from '../dist/releases.js';

const release = { tag_name: 'desktop-v0.2.0', assets: [
  { name: 'Dolphin-0.2.0-arm64.dmg', browser_download_url: 'u/arm64.dmg' },
  { name: 'Dolphin-0.2.0.dmg', browser_download_url: 'u/x64.dmg' },
  { name: 'Dolphin-0.2.0.AppImage', browser_download_url: 'u/app.AppImage' },
  { name: 'dolphin-desktop_0.2.0_amd64.deb', browser_download_url: 'u/app.deb' },
  { name: 'latest-linux.yml', browser_download_url: 'u/latest-linux.yml' },
] };

test('release tags are read as versions and compared numerically', () => {
  assert.deepEqual(releaseVersion('desktop-v0.10.2'), [0, 10, 2]);
  assert.equal(releaseVersion('v0.1.0'), null);
  assert.equal(releaseVersion(undefined), null);
  assert.equal(isNewer([0, 10, 0], '0.9.9'), true);
  assert.equal(isNewer([0, 1, 1], '0.1.1'), false);
  assert.equal(isNewer([0, 1, 0], '0.1.1'), false);
  assert.equal(isNewer([1, 0, 0], '0.99.99'), true);
});

test('each machine gets its own installer', () => {
  assert.equal(installerFor(release, 'darwin', 'arm64', false), 'u/arm64.dmg');
  assert.equal(installerFor(release, 'darwin', 'x64', false), 'u/x64.dmg');
  assert.equal(installerFor(release, 'linux', 'x64', true), 'u/app.AppImage');
  assert.equal(installerFor(release, 'linux', 'x64', false), 'u/app.deb');
  assert.equal(installerFor(release, 'win32', 'x64', false), undefined);
});
