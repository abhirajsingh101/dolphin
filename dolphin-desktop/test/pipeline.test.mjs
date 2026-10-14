// The release pipeline's configuration: what electron-builder makes, and what
// the Desktop workflow builds, checks, uploads and releases. The workflow is
// read as text; these are the lines a careless edit would drop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { checkArtifacts, expectedInstallers } from '../scripts/check-artifacts.mjs';
import { installerFor } from '../dist/releases.js';

const root = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const workflow = readFileSync(path.join(root, '..', '.github', 'workflows', 'desktop.yml'), 'utf8');
const job = (name, next) => workflow.slice(workflow.indexOf(`\n  ${name}:`), next ? workflow.indexOf(`\n  ${next}:`) : undefined);

test('installers are named with their version, platform and architecture', () => {
  assert.equal(pkg.build.artifactName, '${productName}-${version}-${os}-${arch}.${ext}');
  assert.deepEqual(pkg.build.linux.target, ['AppImage', 'deb', 'rpm']);
  assert.deepEqual(pkg.build.mac.target, ['dmg', 'zip']);
});

test('the .deb and .rpm launchers offer New Window, which runs the installed app with --new-window', () => {
  // electron-builder installs both at /opt/<productName>/<package name>.
  const installed = `/opt/${pkg.build.productName}/${pkg.name}`;
  for (const target of ['deb', 'rpm']) {
    const desktop = pkg.build[target].desktop;
    assert.equal(desktop.entry.Actions, 'new-window;', target);
    assert.deepEqual(desktop.desktopActions['new-window'], { Name: 'New Window', Exec: `${installed} --new-window` }, target);
  }
  // An AppImage moves, so its launcher entry carries no fixed path.
  assert.equal(pkg.build.linux.desktop, undefined);
});

test('each build target has exactly its installers and update files', () => {
  assert.deepEqual(expectedInstallers('0.2.0', 'linux-arm64'), ['Dolphin-0.2.0-linux-arm64.AppImage', 'Dolphin-0.2.0-linux-arm64.deb', 'Dolphin-0.2.0-linux-aarch64.rpm']);
  assert.deepEqual(checkArtifacts([...expectedInstallers('0.2.0', 'linux-x64'), 'latest-linux.yml', 'builder-debug.yml', 'linux-unpacked',
    'Dolphin-0.2.0-linux-x86_64.AppImage.blockmap'], '0.2.0', 'linux-x64'), []);
  assert.deepEqual(checkArtifacts(['Dolphin-0.2.0.AppImage', 'Dolphin-0.2.0-linux-amd64.deb', 'latest-linux.yml'], '0.2.0', 'linux-x64'), [
    'missing Dolphin-0.2.0-linux-x86_64.AppImage', 'missing Dolphin-0.2.0-linux-x86_64.rpm', 'unexpected installer Dolphin-0.2.0.AppImage']);
  assert.deepEqual(checkArtifacts(expectedInstallers('0.2.1-beta.1', 'linux-arm64'), '0.2.1-beta.1', 'linux-arm64'), ['missing beta-linux-arm64.yml']);
  assert.deepEqual(checkArtifacts(expectedInstallers('0.2.0', 'darwin-x64'), '0.2.0', 'darwin-x64'), []);
  assert.deepEqual(checkArtifacts([], '0.2.0', 'win32-x64'), ['unknown target win32-x64']);
});

test('the build and the updater agree on installer names', () => {
  const targets = ['linux-x64', 'linux-arm64', 'darwin-arm64', 'darwin-x64'];
  const all = targets.flatMap((target) => expectedInstallers('0.2.0', target) ?? []);
  const release = { assets: all.map((name) => ({ name, browser_download_url: name })) };
  const pkgs = { linux: ['appimage', 'deb', 'rpm'], darwin: ['dmg'] };
  for (const target of targets) {
    const [platform, arch] = target.split('-');
    const picked = pkgs[platform].map((p) => installerFor(release, platform, arch, p));
    const built = expectedInstallers('0.2.0', target).filter((name) => !name.endsWith('.zip'));
    assert.deepEqual(picked, built, `${target}: the updater picks what the build makes`);
  }
});

test('the app job builds Linux arm64, rpm and the mac zip, and checks the names', () => {
  const app = job('app', 'release');
  assert.ok(app.includes('{"target":"linux-arm64","os":"ubuntu-22.04-arm"}'), 'Linux arm64 app build (public repository runners)');
  assert.ok(app.includes('sudo apt-get install -yq rpm'), 'rpmbuild for the rpm target');
  assert.ok(app.includes('node scripts/check-artifacts.mjs release ${{ matrix.target }}'));
  assert.ok(app.includes('-c.extraMetadata.dolphinSigned=true'), 'a signed Mac build updates in place');
  assert.ok(app.includes('release/linux*-unpacked'), 'first run finds the arm64 unpacked app too');
  for (const glob of ['*.AppImage', '*.deb', '*.rpm', '*.dmg', '*.zip', '*.blockmap', '*-linux*.yml']) {
    assert.ok(app.includes(`dolphin-desktop/release/${glob}`), `uploads ${glob}`);
  }
});

test('the release job writes the Mac feed, uses the notes file and marks prereleases', () => {
  const release = job('release');
  assert.ok(release.includes('uses: actions/checkout@v7'));
  assert.ok(release.includes('uses: actions/setup-node@v7'), 'the scripts run on Node');
  assert.ok(release.includes('node dolphin-desktop/scripts/mac-update-feed.mjs release "$version"'));
  assert.ok(release.includes('notes="dolphin-desktop/release-notes/$version.md"'));
  assert.ok(release.includes('--notes-file "$notes"') && release.includes('--generate-notes'));
  assert.ok(release.includes('*-*) args+=(--prerelease)'));
  assert.ok(release.includes('--draft'), 'the owner publishes; CI only drafts');
  assert.ok(release.includes('node dolphin-desktop/scripts/render-cask.mjs release "$version" > release/dolphin-desktop.rb'), 'stable releases carry the cask');
});

test('the Linux x64 first run makes the hero and the release attaches it', () => {
  const app = job('app', 'release');
  assert.ok(app.includes('sudo apt-get install -yq xvfb ffmpeg'));
  assert.ok(app.includes('./scripts/make-hero.sh "$DOLPHIN_SHOTS" "$DOLPHIN_SHOTS/dolphin-hero.gif"'));
  const release = job('release');
  assert.ok(release.includes('name: first-run-linux-x64'));
  assert.ok(release.includes('cp shots/dolphin-hero.gif release/'));
});

test('the README links every installer the release builds, and the hero', () => {
  // Here it is public/overlay/README.md with placeholders; in the public
  // repository it is README.md with the version filled in.
  const file = [path.join(root, '..', 'public', 'overlay', 'README.md'), path.join(root, '..', 'README.md')].find(existsSync);
  const readme = readFileSync(file, 'utf8').replaceAll(pkg.version, '@DESKTOP_VERSION@');
  const base = 'https://github.com/abhirajsingh101/dolphin/releases/download/desktop-v@DESKTOP_VERSION@/';
  const linked = new Set([...readme.matchAll(/releases\/download\/desktop-v@DESKTOP_VERSION@\/(Dolphin-@DESKTOP_VERSION@-[^)\s]+)/g)].map((match) => match[1]));
  const built = new Set(['linux-x64', 'linux-arm64', 'darwin-arm64', 'darwin-x64']
    .flatMap((target) => expectedInstallers('@DESKTOP_VERSION@', target)).filter((name) => !name.endsWith('.zip')));
  assert.deepEqual([...linked].sort(), [...built].sort());
  assert.ok(readme.includes(`${base}dolphin-hero.gif`));
});
