// Launch the real app headlessly: it must start a helper, open the workspace,
// and show System Health for this machine. Run with `npm test` (xvfb-run).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { _electron as electron } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const shots = process.env.DOLPHIN_SHOTS || tmpdir();

test('this computer opens the workspace and System Health', { timeout: 120_000 }, async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'dh-'));
  const app = await electron.launch({
    args: ['--no-sandbox', root],
    env: { ...process.env, DOLPHIN_HOME: home, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', DOLPHIN_GBRAIN: 'off' },
  });
  try {
    const window = await app.firstWindow();
    await window.waitForURL(/app:\/\/dolphin\/desktop\.html/, { timeout: 90_000 });
    await window.getByRole('textbox', { name: 'Message Dolphin' }).waitFor({ timeout: 30_000 });
    await window.getByText(/sessions in view/).waitFor({ timeout: 30_000 });
    assert.equal(await window.getByRole('link', { name: 'Missions' }).count(), 0);

    // No separate title bar: the header is the drag area, its controls stay
    // clickable, and on Linux it leaves room for the window controls drawn over it.
    const chrome = await window.evaluate(() => {
      const region = (selector) => { const style = getComputedStyle(document.querySelector(selector)); return style.getPropertyValue('-webkit-app-region') || style.getPropertyValue('app-region'); };
      const overlay = navigator.windowControlsOverlay;
      return {
        platform: document.documentElement.dataset.platform,
        header: region('.glass-top'),
        search: region('.glass-global-search'),
        overlay: overlay?.visible,
        controlsWidth: overlay ? window.innerWidth - overlay.getTitlebarAreaRect().width : 0,
        headerPadding: parseFloat(getComputedStyle(document.querySelector('.glass-top')).paddingRight),
      };
    });
    assert.equal(chrome.platform, process.platform);
    assert.equal(chrome.header, 'drag');
    assert.equal(chrome.search, 'no-drag');
    if (process.platform !== 'darwin') {
      assert.equal(chrome.overlay, true);
      assert.ok(chrome.headerPadding >= chrome.controlsWidth - 18, `header leaves room for window controls: ${JSON.stringify(chrome)}`);
    }
    await window.screenshot({ path: path.join(shots, 'desktop-workspace.png') });

    await window.getByRole('link', { name: 'System Health' }).click();
    await window.getByRole('link', { name: /Back to Workspace/ }).waitFor();
    await window.getByText(/CPU/).first().waitFor({ timeout: 30_000 });
    await window.waitForTimeout(3000);
    await window.screenshot({ path: path.join(shots, 'desktop-health.png') });
    const bodyText = await window.locator('body').innerText();
    assert.doesNotMatch(bodyText, /Netdata is unavailable|Backend unavailable/);

    // The page scrolls to its last panels, in the glass panel, under the
    // window's own header.
    const scroll = window.locator('.glass-health .health-scroll-area');
    const room = await scroll.evaluate((element) => element.scrollHeight - element.clientHeight);
    assert.ok(room > 0, 'System Health is taller than the window');
    await scroll.hover();
    await window.mouse.wheel(0, 20_000);
    await window.waitForFunction(() => {
      const element = document.querySelector('.glass-health .health-scroll-area');
      return element.scrollTop >= element.scrollHeight - element.clientHeight - 2;
    });
    const last = window.locator('.health-detail-grid').last();
    assert.ok(await last.isVisible() && (await last.boundingBox()).y < (await window.evaluate(() => innerHeight)), 'the last panels come into view');
    await window.screenshot({ path: path.join(shots, 'desktop-health-bottom.png') });
    const region = await window.locator('.glass-health-top').evaluate((element) => getComputedStyle(element).getPropertyValue('-webkit-app-region') || getComputedStyle(element).getPropertyValue('app-region'));
    assert.equal(region, 'drag');

    await window.getByRole('link', { name: /Back to Workspace/ }).click();
    await window.getByRole('textbox', { name: 'Message Dolphin' }).waitFor();

    // Motion: dialogs scale in from their scrim; reduced motion turns it off.
    await window.getByRole('button', { name: 'Open command palette' }).click();
    const panelAnimation = () => window.locator('.cp-panel').evaluate((element) => getComputedStyle(element).animationName);
    assert.equal(await panelAnimation(), 'dd-pop');
    await window.keyboard.press('Escape');
    await window.emulateMedia({ reducedMotion: 'reduce' });
    await window.getByRole('button', { name: 'Open command palette' }).click();
    assert.equal(await panelAnimation(), 'none');
    await window.keyboard.press('Escape');
    await window.emulateMedia({ reducedMotion: 'no-preference' });
  } finally {
    // The app exits directly on quit (see main.ts will-quit), which Playwright's
    // close() does not notice; wait for the process instead.
    const exited = new Promise((resolve) => app.process().once('exit', resolve));
    await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined);
    await exited;
    try { execFileSync(path.resolve(root, '..', 'dolphin-backend', 'venv', 'bin', 'python'), ['-m', 'app.helper', 'stop'], { cwd: path.resolve(root, '..', 'dolphin-backend'), env: { ...process.env, DOLPHIN_HOME: home } }); } catch { /* already stopped */ }
    rmSync(home, { recursive: true, force: true });
  }
});

test('without netdata, System Health uses the built-in monitor; + opens the folder picker', { timeout: 120_000 }, async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'dh-'));
  const app = await electron.launch({
    args: ['--no-sandbox', root],
    env: { ...process.env, DOLPHIN_HOME: home, DOLPHIN_SYSTEM_HEALTH_SOURCE: 'native', ELECTRON_DISABLE_SECURITY_WARNINGS: '1', DOLPHIN_GBRAIN: 'off' },
  });
  try {
    const window = await app.firstWindow();
    await window.waitForURL(/app:\/\/dolphin\/desktop\.html/, { timeout: 90_000 });
    await window.getByRole('button', { name: 'Add a project' }).click();
    const picker = window.getByRole('dialog');
    await picker.waitFor({ timeout: 15_000 });
    await window.screenshot({ path: path.join(shots, 'desktop-picker.png') });
    await window.getByRole('button', { name: 'Close the project picker' }).click();

    await window.getByRole('link', { name: 'System Health' }).click();
    await window.getByText(/Built-in monitor/).waitFor({ timeout: 30_000 });
    await window.getByText(/CPU/).first().waitFor();
    await window.waitForTimeout(6000);
    await window.screenshot({ path: path.join(shots, 'desktop-health-native.png') });
  } finally {
    const exited = new Promise((resolve) => app.process().once('exit', resolve));
    await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined);
    await exited;
    try { execFileSync(path.resolve(root, '..', 'dolphin-backend', 'venv', 'bin', 'python'), ['-m', 'app.helper', 'stop'], { cwd: path.resolve(root, '..', 'dolphin-backend'), env: { ...process.env, DOLPHIN_HOME: home } }); } catch { /* already stopped */ }
    rmSync(home, { recursive: true, force: true });
  }
});
