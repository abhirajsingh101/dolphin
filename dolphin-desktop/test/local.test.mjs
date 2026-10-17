// Launch the real app headlessly: it must start a helper, open the workspace,
// and show System Health for this machine. Run with `npm test` (xvfb-run).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import { teardown } from './support.mjs';

const root = path.resolve(import.meta.dirname, '..');
const shots = process.env.DOLPHIN_SHOTS || tmpdir();
async function waitFor(check, what, timeoutMs = 10_000) {
  for (const end = Date.now() + timeoutMs; Date.now() < end;) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`timed out: ${what}`);
}

test('this computer opens the workspace and System Health', { timeout: 120_000 }, async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'dh-'));
  const app = await electron.launch({
    args: ['--no-sandbox', `--user-data-dir=${path.join(home, 'profile')}`, root],
    env: { ...process.env, DOLPHIN_HOME: home, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', DOLPHIN_GBRAIN: 'off', DOLPHIN_TMUX_IMPORT: 'off' },
  });
  try {
    const window = await app.firstWindow();
    await window.waitForURL(/app:\/\/dolphin\/desktop\.html/, { timeout: 90_000 });
    await window.getByRole('textbox', { name: 'Message Dolphin' }).waitFor({ timeout: 30_000 });
    await window.getByText(/sessions in view/).waitFor({ timeout: 30_000 });
    // This computer connected once: its link's epoch moved from 0 to 1.
    const local = await window.evaluate(() => window.dolphinDesktop.machineList().find((m) => m.id === 'local'));
    assert.equal(local.state, 'connected');
    assert.equal(local.epoch, 1);
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
    // The page's theme choice becomes the app's (theme.ts): the static pages,
    // the window's background and its controls follow it, and it is kept.
    const pickTheme = (choice) => window.evaluate((value) => { localStorage.setItem('dolphin.theme', value); window.dispatchEvent(new Event('dolphin:settings')); }, choice);
    const nativeSource = () => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource);
    await pickTheme('dark');
    await waitFor(async () => (await nativeSource()) === 'dark', 'the app takes the page theme');
    assert.equal(await window.evaluate(() => window.dolphinDesktop.theme()), 'dark');
    assert.equal((await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBackgroundColor())).toLowerCase(), '#091421');
    assert.deepEqual(JSON.parse(readFileSync(path.join(home, 'profile', 'theme.json'), 'utf8')), { theme: 'dark' });
    await pickTheme('system');
    await waitFor(async () => (await nativeSource()) === 'system', 'System follows the system again');
    // Machine sections: one sticky 28px row each.
    const head = await window.locator('.glass-machine-head').first().evaluate((element) => ({ position: getComputedStyle(element).position, height: Math.round(element.getBoundingClientRect().height) }));
    assert.deepEqual(head, { position: 'sticky', height: 28 });
    // A fullscreen project window starts below the window controls in a window;
    // in macOS full screen its header keeps the traffic lights' corner free.
    // desktop.css keys both on attributes, so each case is set and measured here.
    const fullscreen = await window.evaluate(() => {
      const root = document.documentElement;
      const before = { platform: root.dataset.platform, full: 'fullscreen' in root.dataset };
      const frame = document.createElement('section');
      frame.className = 'glass-session-window';
      frame.dataset.fullscreen = 'true';
      const title = document.createElement('div');
      title.className = 'glass-window-title';
      frame.append(title);
      document.querySelector('.glass-workspace').append(frame);
      const firstControl = document.querySelector('.glass-top :is(button, a, input)');
      const measure = () => ({ top: frame.getBoundingClientRect().top, left: parseFloat(getComputedStyle(title).paddingLeft), control: firstControl.getBoundingClientRect().left });
      delete root.dataset.fullscreen;
      const here = measure();
      root.dataset.platform = 'darwin';
      const macWindow = measure();
      root.dataset.fullscreen = '';
      const macFull = measure();
      root.dataset.platform = before.platform;
      if (!before.full) delete root.dataset.fullscreen;
      frame.remove();
      return { here, macWindow, macFull };
    });
    assert.equal(fullscreen.here.top, 44, JSON.stringify(fullscreen));
    assert.equal(fullscreen.macWindow.top, 44, JSON.stringify(fullscreen));
    assert.equal(fullscreen.macFull.top, 0, JSON.stringify(fullscreen));
    assert.ok(fullscreen.macFull.left >= 72, JSON.stringify(fullscreen));
    // In a Mac window the traffic lights end near x 70; the first header control starts clear of them.
    assert.ok(fullscreen.macWindow.control >= 78, JSON.stringify(fullscreen));

    // Keyboard commands are menu items: they open the palette and Settings.
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('palette').click());
    await window.getByRole('dialog', { name: 'Command palette' }).waitFor();
    await window.keyboard.press('Escape');
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('settings').click());
    await window.getByRole('dialog', { name: 'Settings' }).waitFor();
    await window.screenshot({ path: path.join(shots, 'desktop-settings.png') });
    await window.keyboard.press('Escape');

    await window.getByRole('textbox', { name: 'Message Dolphin' }).fill('Keep this while I check health');
    await window.getByRole('link', { name: 'System Health' }).click();
    await window.getByRole('link', { name: /Back to Workspace/ }).waitFor();
    // An overlay: the workspace stays mounted underneath, out of reach.
    assert.equal(await window.locator('.glass-workspace').count(), 1);
    assert.equal(await window.locator('.glass-workspace').getAttribute('inert'), '');
    assert.equal(await window.locator('.glass-health').getAttribute('aria-modal'), 'true');
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
    // The workspace stays mounted beneath System Health, so its message box is
    // always visible: wait for the overlay itself to go before checking it.
    await window.locator('.glass-health').waitFor({ state: 'detached' });
    assert.equal(await window.getByRole('textbox', { name: 'Message Dolphin' }).inputValue(), 'Keep this while I check health');
    assert.equal(await window.locator('.glass-workspace').getAttribute('inert'), null);
    // A machine that is not connected: said plainly, never this computer's numbers.
    await window.evaluate(() => { location.hash = '#/health/gpu-box'; });
    await window.getByText('gpu-box is not connected.').waitFor();
    assert.equal(await window.getByText(/CPU/).count(), 0);
    // Its chip carries no "connected" dot.
    assert.equal(await window.locator('.glass-health .health-machine-trigger').getAttribute('data-state'), 'unknown');
    // The header's machine menu lists this computer and the machine on
    // screen, and switches in place: the hash moves, the overlay stays.
    await window.getByRole('button', { name: /Choose a machine/ }).click();
    const menu = window.getByRole('menu', { name: 'Machines' });
    await menu.waitFor();
    assert.equal(await menu.getByRole('menuitemradio', { name: /gpu-box/ }).getAttribute('aria-checked'), 'true');
    await menu.getByRole('menuitemradio', { name: /This computer/ }).click();
    await window.waitForFunction(() => location.hash === '#/health');
    await window.getByText(/CPU/).first().waitFor({ timeout: 30_000 });
    assert.equal(await window.locator('.glass-health').count(), 1);
    await window.getByRole('link', { name: /Back to Workspace/ }).focus();
    await window.keyboard.press('Escape');
    await window.getByRole('textbox', { name: 'Message Dolphin' }).waitFor();
    await window.getByRole('textbox', { name: 'Message Dolphin' }).fill('');

    // Motion: dialogs rise and scale out of their scrim (Motion, not a CSS
    // animation, so nothing else animates the panel); reduced motion keeps
    // only the fade. Sampled frame by frame from the click.
    const panelTransforms = () => window.evaluate(() => new Promise((resolve) => {
      const seen = [];
      const trigger = document.querySelector('[aria-label="Open command palette"]');
      trigger.focus();
      trigger.click();
      const tick = () => {
        const panel = document.querySelector('.cp-panel');
        if (panel) seen.push({ transform: getComputedStyle(panel).transform, animation: getComputedStyle(panel).animationName });
        if (seen.length < 12) requestAnimationFrame(tick); else resolve(seen);
      };
      tick();
    }));
    const moved = (frames) => frames.some((frame) => !['none', 'matrix(1, 0, 0, 1, 0, 0)'].includes(frame.transform));
    const animated = await panelTransforms();
    assert.ok(moved(animated), 'the palette rises into place');
    assert.ok(animated.every((frame) => frame.animation === 'none'), 'no CSS animation on the panel');
    await window.keyboard.press('Escape');
    await window.locator('.cp-scrim').waitFor({ state: 'detached' });
    await window.emulateMedia({ reducedMotion: 'reduce' });
    assert.ok(!moved(await panelTransforms()), 'reduced motion: no transform');
    await window.keyboard.press('Escape');
    await window.locator('.cp-scrim').waitFor({ state: 'detached' });
    await window.emulateMedia({ reducedMotion: 'no-preference' });
  } finally {
    await teardown({ app, helpers: [home], remove: [home] });
  }
});

test('without netdata, System Health uses the built-in monitor; + opens the folder picker', { timeout: 120_000 }, async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'dh-'));
  const app = await electron.launch({
    args: ['--no-sandbox', `--user-data-dir=${path.join(home, 'profile')}`, root],
    env: { ...process.env, DOLPHIN_HOME: home, DOLPHIN_SYSTEM_HEALTH_SOURCE: 'native', ELECTRON_DISABLE_SECURITY_WARNINGS: '1', DOLPHIN_GBRAIN: 'off', DOLPHIN_TMUX_IMPORT: 'off' },
  });
  try {
    const window = await app.firstWindow();
    await window.waitForURL(/app:\/\/dolphin\/desktop\.html/, { timeout: 90_000 });
    await window.getByRole('button', { name: 'Add a project on This Computer' }).click();
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
    await teardown({ app, helpers: [home], remove: [home] });
  }
});
