// Updates, as the user meets them: quiet checks, a header pill only when there
// is something to do, the About panel (logo, menu) with a check on demand, and
// a one-time "what's new" after an update.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { _electron as electron } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const shots = process.env.DOLPHIN_SHOTS || tmpdir();
const appVersion = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;

const newer = { tag_name: 'desktop-v9.9.9', html_url: 'https://example.invalid/release', assets: [
  { name: 'Dolphin-9.9.9-arm64.dmg', browser_download_url: 'https://example.invalid/arm64.dmg' },
  { name: 'Dolphin-9.9.9.dmg', browser_download_url: 'https://example.invalid/x64.dmg' },
  { name: 'Dolphin-9.9.9.AppImage', browser_download_url: 'https://example.invalid/app.AppImage' },
  { name: 'dolphin-desktop_9.9.9_amd64.deb', browser_download_url: 'https://example.invalid/app.deb' },
] };
const same = { tag_name: `desktop-v${appVersion}`, html_url: 'https://example.invalid/same', assets: [] };

/** A release feed the test can change: what it answers, or a failure. */
async function startFeed() {
  const feed = { release: same, failing: false };
  const server = createServer((_request, response) => {
    if (feed.failing) { response.statusCode = 503; response.end(); return; }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(feed.release));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  feed.url = `http://127.0.0.1:${server.address().port}/latest`;
  feed.close = () => server.close();
  return feed;
}

async function launch(home, feed, { lastVersion } = {}) {
  const profile = path.join(home, 'profile');
  mkdirSync(profile, { recursive: true });
  if (lastVersion) writeFileSync(path.join(profile, 'last-version'), lastVersion);
  const app = await electron.launch({
    // Its own profile: the last-run version lives there, and must not leak between runs.
    args: ['--no-sandbox', `--user-data-dir=${profile}`, root],
    env: { ...process.env, DOLPHIN_HOME: home, DOLPHIN_GBRAIN: 'off', ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      DOLPHIN_DESKTOP_UPDATE_FEED: feed.url, DOLPHIN_DESKTOP_UPDATE_DELAY_MS: '500' },
  });
  const window = await app.firstWindow();
  await window.waitForURL(/desktop\.html/, { timeout: 90_000 });
  await window.getByRole('button', { name: 'Open command palette' }).waitFor({ timeout: 60_000 });
  return { app, window };
}

async function close(app, home) {
  const exited = new Promise((resolve) => app.process().once('exit', resolve));
  await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined);
  await exited;
  try { execFileSync(path.resolve(root, '..', 'dolphin-backend', 'venv', 'bin', 'python'), ['-m', 'app.helper', 'stop'], { cwd: path.resolve(root, '..', 'dolphin-backend'), env: { ...process.env, DOLPHIN_HOME: home } }); } catch { /* not running */ }
}

test('a newer release shows as a pill; its panel downloads the installer', { timeout: 150_000 }, async () => {
  const feed = await startFeed();
  feed.release = newer;
  const home = mkdtempSync(path.join(tmpdir(), 'dup-'));
  const { app, window } = await launch(home, feed);
  try {
    // Record what Download would open instead of opening a browser.
    await app.evaluate(({ shell }) => { globalThis.opened = []; shell.openExternal = async (url) => { globalThis.opened.push(url); }; });

    const pill = window.getByRole('button', { name: 'Update', exact: true });
    await pill.waitFor({ timeout: 30_000 });
    // Nothing interrupts: no dialog opened by itself.
    assert.equal(await window.getByRole('dialog', { name: 'About Dolphin' }).count(), 0);
    await pill.click();
    const panel = window.getByRole('dialog', { name: 'About Dolphin' });
    await panel.getByText('Dolphin 9.9.9 is available').waitFor();
    await panel.getByText(`Version ${appVersion}`).waitFor();
    assert.equal(await panel.getByRole('link', { name: 'What’s new' }).getAttribute('href'), 'https://example.invalid/release');
    await window.screenshot({ path: path.join(shots, 'desktop-update.png') });

    await panel.getByRole('button', { name: 'Download' }).click();
    const opened = await app.evaluate(() => globalThis.opened);
    const expected = process.platform === 'darwin'
      ? (process.arch === 'arm64' ? 'https://example.invalid/arm64.dmg' : 'https://example.invalid/x64.dmg')
      : 'https://example.invalid/app.deb'; // a development build is not an AppImage
    assert.deepEqual(opened, [expected]);

    await window.keyboard.press('Escape');
    await panel.waitFor({ state: 'detached' });
    assert.equal(await pill.isVisible(), true);
  } finally {
    await close(app, home);
    feed.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('the logo and the menu open About; a check on demand says what it found', { timeout: 150_000 }, async () => {
  const feed = await startFeed();
  feed.failing = true; // the quiet first check fails: nothing may show for it
  const home = mkdtempSync(path.join(tmpdir(), 'dup-'));
  const { app, window } = await launch(home, feed);
  try {
    await window.waitForTimeout(2_000);
    assert.equal(await window.getByRole('button', { name: /^(Update|Updating|Restart to Update)$/ }).count(), 0);
    assert.equal(await window.getByText('Could not check for updates').count(), 0);

    await window.getByRole('button', { name: 'About Dolphin' }).click();
    const panel = window.getByRole('dialog', { name: 'About Dolphin' });
    await panel.waitFor();
    await panel.getByText('Not checked yet').waitFor();

    // Asked for, a failure explains itself and offers to try again.
    await panel.getByRole('button', { name: 'Check for Updates' }).click();
    await panel.getByText('Could not check for updates').waitFor({ timeout: 15_000 });
    feed.failing = false;
    await panel.getByRole('button', { name: 'Try Again' }).click();
    await panel.getByText('Dolphin is up to date').waitFor({ timeout: 15_000 });
    await panel.getByText('Checked just now').waitFor();
    await window.screenshot({ path: path.join(shots, 'desktop-about.png') });

    // Clicking outside closes it; Check for Updates… in the menu opens it again.
    await window.mouse.click(700, 500);
    await panel.waitFor({ state: 'detached' });
    await app.evaluate(({ Menu, BrowserWindow }) => {
      const find = (items) => items.flatMap((item) => [item, ...(item.submenu ? find(item.submenu.items) : [])]);
      find(Menu.getApplicationMenu().items).find((item) => item.label === 'Check for Updates…').click(undefined, BrowserWindow.getAllWindows()[0]);
    });
    await panel.getByText('Dolphin is up to date').waitFor({ timeout: 15_000 });
  } finally {
    await close(app, home);
    feed.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('after an update, one toast says what is new', { timeout: 150_000 }, async () => {
  const feed = await startFeed();
  const home = mkdtempSync(path.join(tmpdir(), 'dup-'));
  const { app, window } = await launch(home, feed, { lastVersion: '0.0.1' });
  try {
    const toast = window.getByRole('status', { name: 'Dolphin updated' });
    await toast.getByText(`Updated to Dolphin ${appVersion}`).waitFor({ timeout: 15_000 });
    assert.equal(await toast.getByRole('link', { name: 'See what’s new' }).getAttribute('href'),
      `https://github.com/abhirajsingh101/dolphin/releases/tag/desktop-v${appVersion}`);
    await window.screenshot({ path: path.join(shots, 'desktop-whats-new.png') });
    await toast.getByRole('button', { name: 'Dismiss' }).click();
    await toast.waitFor({ state: 'detached' });
    // Once: a reload does not bring it back, and the profile now records this version.
    await window.reload();
    await window.getByRole('button', { name: 'Open command palette' }).waitFor();
    assert.equal(await window.getByRole('status', { name: 'Dolphin updated' }).count(), 0);
    assert.equal(readFileSync(path.join(home, 'profile', 'last-version'), 'utf8'), appVersion);
  } finally {
    await close(app, home);
    feed.close();
    rmSync(home, { recursive: true, force: true });
  }
});
