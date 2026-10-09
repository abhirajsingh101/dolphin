// A newer release appears: the app offers it above the chat, Download opens
// this machine's installer, and Later hides that version.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { _electron as electron } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const shots = process.env.DOLPHIN_SHOTS || tmpdir();

test('a newer release is offered with its installer, and Later hides it', { timeout: 150_000 }, async () => {
  const release = { tag_name: 'desktop-v9.9.9', html_url: 'https://example.invalid/release', assets: [
    { name: 'Dolphin-9.9.9-arm64.dmg', browser_download_url: 'https://example.invalid/arm64.dmg' },
    { name: 'Dolphin-9.9.9.dmg', browser_download_url: 'https://example.invalid/x64.dmg' },
    { name: 'Dolphin-9.9.9.AppImage', browser_download_url: 'https://example.invalid/app.AppImage' },
    { name: 'dolphin-desktop_9.9.9_amd64.deb', browser_download_url: 'https://example.invalid/app.deb' },
  ] };
  const feed = createServer((_request, response) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(release)); });
  await new Promise((resolve) => feed.listen(0, '127.0.0.1', resolve));
  const home = mkdtempSync(path.join(tmpdir(), 'dup-'));
  const app = await electron.launch({
    // Its own profile: Later is remembered there, and must not leak between runs.
    args: ['--no-sandbox', `--user-data-dir=${path.join(home, 'profile')}`, root],
    env: { ...process.env, DOLPHIN_HOME: home, DOLPHIN_GBRAIN: 'off', ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      DOLPHIN_DESKTOP_UPDATE_FEED: `http://127.0.0.1:${feed.address().port}/latest`, DOLPHIN_DESKTOP_UPDATE_DELAY_MS: '500' },
  });
  try {
    const window = await app.firstWindow();
    await window.waitForURL(/desktop\.html/, { timeout: 90_000 });
    // Record what Download would open instead of opening a browser.
    await app.evaluate(({ shell }) => { globalThis.opened = []; shell.openExternal = async (url) => { globalThis.opened.push(url); }; });

    const notice = window.getByRole('region', { name: 'Update' });
    await notice.getByText('Dolphin 9.9.9 is available.').waitFor({ timeout: 30_000 });
    await window.screenshot({ path: path.join(shots, 'desktop-update.png') });
    await notice.getByRole('button', { name: 'Download' }).click();
    const opened = await app.evaluate(() => globalThis.opened);
    const expected = process.platform === 'darwin'
      ? (process.arch === 'arm64' ? 'https://example.invalid/arm64.dmg' : 'https://example.invalid/x64.dmg')
      : 'https://example.invalid/app.deb'; // a development build is not an AppImage
    assert.deepEqual(opened, [expected]);

    await notice.getByRole('button', { name: 'Later' }).click();
    await notice.waitFor({ state: 'detached' });
    await window.reload();
    await window.getByRole('button', { name: 'Open command palette' }).waitFor();
    assert.equal(await window.getByRole('region', { name: 'Update' }).count(), 0);
  } finally {
    const exited = new Promise((resolve) => app.process().once('exit', resolve));
    await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined);
    await exited;
    feed.close();
    try { execFileSync(path.resolve(root, '..', 'dolphin-backend', 'venv', 'bin', 'python'), ['-m', 'app.helper', 'stop'], { cwd: path.resolve(root, '..', 'dolphin-backend'), env: { ...process.env, DOLPHIN_HOME: home } }); } catch { /* not running */ }
    rmSync(home, { recursive: true, force: true });
  }
});
