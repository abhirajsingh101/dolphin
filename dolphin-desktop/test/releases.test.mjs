// Which release is newer, which one each update channel may offer, and which
// installer fits which machine, for 0.2.0's names and for 0.1.x's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canSelfUpdate, compareVersions, dropStagedUpdate, installerFor, isNewer, linuxPackage, pickRelease, releaseVersion, tagVersion, updateFilesChannel } from '../dist/releases.js';

const assets = (names) => names.map((name) => ({ name, browser_download_url: `u/${name}` }));
const release = { tag_name: 'desktop-v0.2.0', assets: assets([
  'Dolphin-0.2.0-mac-arm64.dmg', 'Dolphin-0.2.0-mac-x64.dmg', 'Dolphin-0.2.0-mac-arm64.zip', 'Dolphin-0.2.0-mac-x64.zip',
  'Dolphin-0.2.0-linux-x86_64.AppImage', 'Dolphin-0.2.0-linux-arm64.AppImage',
  'Dolphin-0.2.0-linux-amd64.deb', 'Dolphin-0.2.0-linux-arm64.deb',
  'Dolphin-0.2.0-linux-x86_64.rpm', 'Dolphin-0.2.0-linux-aarch64.rpm', 'latest-linux.yml',
]) };
// 0.1.x named installers without an architecture (x64), or -arm64 for Apple Silicon.
const old = { tag_name: 'desktop-v0.1.11', assets: assets(['Dolphin-0.1.11-arm64.dmg', 'Dolphin-0.1.11.dmg', 'Dolphin-0.1.11.AppImage', 'dolphin-desktop_0.1.11_amd64.deb']) };

// Shared with dolphin-backend/tests/test_helper_mode.py (VERSION_ORDER): the
// helper and the app must agree on which version is newer.
const VERSION_ORDER = ['0.1.11', '0.2.0', '0.2.1-beta.1', '0.2.1-beta.2', '0.2.1-beta.10', '0.2.1-rc.1', '0.2.1', '0.10.0'];

test('release tags are read as versions, prereleases included', () => {
  assert.deepEqual(releaseVersion('desktop-v0.10.2'), [0, 10, 2]);
  assert.equal(tagVersion('desktop-v0.3.0-beta.2'), '0.3.0-beta.2');
  assert.equal(tagVersion('desktop-v0.3.0'), '0.3.0');
  assert.equal(tagVersion('v0.3.0'), null);
  assert.equal(tagVersion('desktop-v0.3'), null);
  assert.equal(tagVersion(undefined), null);
});

test('versions compare as semver: a prerelease comes before its release', () => {
  const order = ['0.1.11', '0.2.0-beta.1', '0.2.0-beta.2', '0.2.0-beta.10', '0.2.0-rc.1', '0.2.0', '0.2.1', '0.10.0'];
  for (let index = 0; index < order.length - 1; index += 1) {
    assert.ok(compareVersions(order[index], order[index + 1]) < 0, `${order[index]} < ${order[index + 1]}`);
    assert.ok(compareVersions(order[index + 1], order[index]) > 0, `${order[index + 1]} > ${order[index]}`);
  }
  assert.equal(compareVersions('0.2.0', '0.2.0'), 0);
  assert.equal(isNewer([0, 10, 0], '0.9.9'), true);
  assert.equal(isNewer([0, 1, 1], '0.1.1'), false);
});

test('the shared version table orders the same way as the helper', () => {
  for (let index = 0; index < VERSION_ORDER.length - 1; index += 1) {
    assert.ok(compareVersions(VERSION_ORDER[index], VERSION_ORDER[index + 1]) < 0, `${VERSION_ORDER[index]} < ${VERSION_ORDER[index + 1]}`);
  }
  assert.ok(compareVersions('0.2.1-beta.10', '0.2.1-beta.2') > 0);
  assert.ok(compareVersions('0.2.1-beta.1', '0.2.1') < 0);
});

test('each channel picks the newest release it may offer', () => {
  const r = (tag, extra = {}) => ({ tag_name: tag, ...extra });
  const feed = [r('desktop-v0.2.0'), r('desktop-v0.2.1-beta.1', { prerelease: true }), r('desktop-v0.3.0', { draft: true }), r('nightly'), r('desktop-v0.1.11')];
  assert.equal(pickRelease(feed, 'stable')?.tag_name, 'desktop-v0.2.0');
  assert.equal(pickRelease(feed, 'beta')?.tag_name, 'desktop-v0.2.1-beta.1');
  // A prerelease tag never reaches stable, even when the release is not marked as one.
  assert.equal(pickRelease([r('desktop-v0.2.0'), r('desktop-v0.2.1-beta.1')], 'stable')?.tag_name, 'desktop-v0.2.0');
  // Beta gets the stable release once it is newer than every prerelease.
  assert.equal(pickRelease([r('desktop-v0.2.1'), r('desktop-v0.2.1-beta.3', { prerelease: true })], 'beta')?.tag_name, 'desktop-v0.2.1');
  // Back on stable while running a beta: the older stable release is not newer, so nothing is offered.
  assert.ok(compareVersions(tagVersion(pickRelease(feed, 'stable').tag_name), '0.2.1-beta.1') < 0);
  assert.equal(pickRelease([], 'beta'), undefined);
});

test('each machine gets its own installer', () => {
  assert.equal(installerFor(release, 'darwin', 'arm64', 'dmg'), 'u/Dolphin-0.2.0-mac-arm64.dmg');
  assert.equal(installerFor(release, 'darwin', 'x64', 'dmg'), 'u/Dolphin-0.2.0-mac-x64.dmg');
  assert.equal(installerFor(release, 'linux', 'x64', 'appimage'), 'u/Dolphin-0.2.0-linux-x86_64.AppImage');
  assert.equal(installerFor(release, 'linux', 'arm64', 'appimage'), 'u/Dolphin-0.2.0-linux-arm64.AppImage');
  assert.equal(installerFor(release, 'linux', 'x64', 'deb'), 'u/Dolphin-0.2.0-linux-amd64.deb');
  assert.equal(installerFor(release, 'linux', 'arm64', 'deb'), 'u/Dolphin-0.2.0-linux-arm64.deb');
  assert.equal(installerFor(release, 'linux', 'x64', 'rpm'), 'u/Dolphin-0.2.0-linux-x86_64.rpm');
  assert.equal(installerFor(release, 'linux', 'arm64', 'rpm'), 'u/Dolphin-0.2.0-linux-aarch64.rpm');
  assert.equal(installerFor(release, 'win32', 'x64', 'deb'), undefined);
  assert.equal(installerFor(release, 'linux', 'x64', 'dmg'), undefined);
});

test('0.1.x installer names still resolve, and never to the wrong architecture', () => {
  assert.equal(installerFor(old, 'darwin', 'arm64', 'dmg'), 'u/Dolphin-0.1.11-arm64.dmg');
  assert.equal(installerFor(old, 'darwin', 'x64', 'dmg'), 'u/Dolphin-0.1.11.dmg');
  assert.equal(installerFor(old, 'linux', 'x64', 'appimage'), 'u/Dolphin-0.1.11.AppImage');
  assert.equal(installerFor(old, 'linux', 'x64', 'deb'), 'u/dolphin-desktop_0.1.11_amd64.deb');
  assert.equal(installerFor(old, 'linux', 'arm64', 'appimage'), undefined);
  assert.equal(installerFor(old, 'linux', 'x64', 'rpm'), undefined);
});

test('who can update in place, and which update files they read', () => {
  assert.equal(canSelfUpdate({ platform: 'linux', packaged: true, appImage: true, signed: false }), true);
  assert.equal(canSelfUpdate({ platform: 'linux', packaged: true, appImage: false, signed: false }), false);
  assert.equal(canSelfUpdate({ platform: 'darwin', packaged: true, appImage: false, signed: false }), false);
  assert.equal(canSelfUpdate({ platform: 'darwin', packaged: true, appImage: false, signed: true }), true);
  assert.equal(canSelfUpdate({ platform: 'linux', packaged: false, appImage: true, signed: false }), false);
  assert.equal(linuxPackage({ appImage: true, hasDpkg: true, hasRpm: false }), 'appimage');
  assert.equal(linuxPackage({ appImage: false, hasDpkg: true, hasRpm: true }), 'deb');
  assert.equal(linuxPackage({ appImage: false, hasDpkg: false, hasRpm: true }), 'rpm');
  assert.equal(linuxPackage({ appImage: false, hasDpkg: false, hasRpm: false }), 'deb');
  assert.equal(updateFilesChannel('0.2.0'), 'latest');
  assert.equal(updateFilesChannel('0.2.1-beta.3'), 'beta');
  assert.equal(updateFilesChannel('0.2.1-rc.1'), 'rc');
});

test('dropping a staged prerelease aborts the download, unstages the install and clears the cache', async () => {
  const calls = [];
  const updater = { autoInstallOnAppQuit: true, downloadedUpdateHelper: { clear: async () => { calls.push('clear'); } } };
  await dropStagedUpdate(updater, { cancel: () => calls.push('cancel') });
  assert.equal(updater.autoInstallOnAppQuit, false, 'quitting must not install it');
  assert.deepEqual(calls, ['cancel', 'clear']);
  // Nothing downloaded yet, or no token: nothing to throw about.
  await dropStagedUpdate({ autoInstallOnAppQuit: true, downloadedUpdateHelper: null });
});
