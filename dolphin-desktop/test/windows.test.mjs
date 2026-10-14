// File → New Window: another workspace over the same machines and the same
// helper, with a layout of its own. Every window comes back after a quit;
// closing one of several forgets it; menu commands go to the window in front.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchApp, quitApp, scratchEnv, teardown } from './support.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function workspace(window) {
  await window.waitForURL(/app:\/\/dolphin\/desktop\.html/, { timeout: 90_000 });
  await window.waitForSelector('.glass-workspace', { timeout: 60_000 });
  return window;
}

/** Every open window's page, in the order the main process made them, once each shows the workspace. */
async function windowsOf(app, count) {
  for (let i = 0; i < 300 && app.windows().length < count; i += 1) await sleep(100);
  assert.equal(app.windows().length, count, `${count} windows`);
  return Promise.all(app.windows().map(workspace));
}

const collapsed = (window) => window.locator('.glass-workspace').getAttribute('data-sidebar-collapsed');
const slotOf = (window) => window.evaluate(() => window.dolphinDesktop.window);

test('New Window opens another workspace with its own layout; the windows come back after a quit', { timeout: 300_000 }, async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'dwin-'));
  const profile = path.join(home, 'profile');
  mkdirSync(profile, { recursive: true });
  const sessionFile = path.join(profile, 'session.json');
  const env = scratchEnv(home, { DOLPHIN_TMUX_IMPORT: 'off' });
  let app;
  try {
    app = await launchApp(home, env);
    const first = await workspace(await app.firstWindow());

    // The menu: New Window heads File, with this platform's key.
    const file = await app.evaluate(({ Menu }) => {
      const menu = Menu.getApplicationMenu().items.find((item) => item.label === 'File');
      return menu.submenu.items.map((item) => [item.id ?? '', item.label, item.accelerator ?? '']);
    });
    assert.deepEqual(file[0], ['new-window', 'New Window', process.platform === 'darwin' ? 'Cmd+N' : 'Ctrl+Shift+N']);

    // The first window collapses its sidebar. A window 2 that was closed long
    // ago left a layout behind; a new window 2 must not inherit it.
    assert.deepEqual(await slotOf(first), { slot: 1, fresh: false });
    await first.evaluate(() => {
      localStorage.setItem('dolphin.glass.sidebar-collapsed', 'true');
      localStorage.setItem('dolphin.glass.sidebar-collapsed@2', 'true');
      localStorage.setItem('dolphin.glass.chat-draft@2', '{"initial":"stale"}');
    });
    await first.reload();
    await workspace(first);
    assert.equal(await collapsed(first), 'true');

    await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('new-window').click());
    const [, second] = await windowsOf(app, 2);
    assert.deepEqual(await slotOf(second), { slot: 2, fresh: true });
    assert.equal(await collapsed(second), 'false', 'a new window starts with an empty layout');
    assert.doesNotMatch(await second.evaluate(() => localStorage.getItem('dolphin.glass.chat-draft@2') ?? ''), /stale/);
    // Shared: the same machines over the same helper, and the first window keeps its layout.
    const config = (window) => window.evaluate(() => window.dolphinDesktop.config.apiBase);
    assert.equal(await config(second), await config(first));
    assert.deepEqual(await second.evaluate(() => window.dolphinDesktop.machineList().map((m) => [m.id, m.state])), [['local', 'connected']]);
    assert.equal(await first.evaluate(() => localStorage.getItem('dolphin.glass.sidebar-collapsed')), 'true');
    const titles = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((window) => window.getTitle()).sort());
    assert.deepEqual(titles, ['Dolphin', 'Dolphin (2)']);

    // A menu command goes to the window in front, and only to it.
    for (const window of [first, second]) await window.evaluate(() => { window.__heard = []; window.dolphinDesktop.onCommand((id) => window.__heard.push(id)); });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((window) => window.getTitle() === 'Dolphin').focus());
    await sleep(300);
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('next-tab').click());
    await sleep(500);
    assert.deepEqual([await first.evaluate(() => window.__heard), await second.evaluate(() => window.__heard)], [['next-tab'], []]);

    // Quit: both windows are saved, each with its number.
    await quitApp(app);
    app = undefined;
    const saved = JSON.parse(readFileSync(sessionFile, 'utf8'));
    assert.deepEqual(saved.windows.map((window) => window.slot).sort(), [1, 2]);

    // Next launch: both come back, each with its own layout, neither fresh.
    app = await launchApp(home, env);
    await app.firstWindow();
    const back = await windowsOf(app, 2);
    const bySlot = Object.fromEntries(await Promise.all(back.map(async (window) => [(await slotOf(window)).slot, window])));
    assert.deepEqual(await slotOf(bySlot[2]), { slot: 2, fresh: false });
    assert.equal(await collapsed(bySlot[1]), 'true');
    assert.equal(await collapsed(bySlot[2]), 'false');

    // Closing one of the two (not quitting) forgets it; Dolphin keeps running.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((window) => window.getTitle() === 'Dolphin (2)').close());
    for (let i = 0; i < 50 && app.windows().length > 1; i += 1) await sleep(100);
    assert.equal(app.windows().length, 1);
    const slots = () => JSON.parse(readFileSync(sessionFile, 'utf8')).windows.map((window) => window.slot);
    for (let i = 0; i < 50 && slots().length > 1; i += 1) await sleep(100);
    assert.deepEqual(slots(), [1]);
  } finally {
    await teardown({ app, helpers: [[env.DOLPHIN_HOME, { env }]], remove: [home] });
  }
});

test('a session saved before windows existed opens as one window, number 1, in its place', { timeout: 150_000 }, async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'dwin-'));
  const profile = path.join(home, 'profile');
  mkdirSync(profile, { recursive: true });
  writeFileSync(path.join(profile, 'session.json'), JSON.stringify({ machines: [], bounds: { x: 40, y: 30, width: 1000, height: 700 } }));
  const env = scratchEnv(home, { DOLPHIN_TMUX_IMPORT: 'off' });
  let app;
  try {
    app = await launchApp(home, env);
    const [only] = await windowsOf(app, 1);
    assert.deepEqual(await slotOf(only), { slot: 1, fresh: false });
    const size = await app.evaluate(({ BrowserWindow }) => {
      const { width, height } = BrowserWindow.getAllWindows()[0].getBounds();
      return { width, height };
    });
    assert.deepEqual(size, { width: 1000, height: 700 });
  } finally {
    await teardown({ app, helpers: [[env.DOLPHIN_HOME, { env }]], remove: [home] });
  }
});

test('closing every window at once, as a desktop\'s Close All does, keeps them all for next time', { timeout: 200_000 }, async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'dwin-'));
  const profile = path.join(home, 'profile');
  const env = scratchEnv(home, { DOLPHIN_TMUX_IMPORT: 'off' });
  let app;
  try {
    app = await launchApp(home, env);
    await workspace(await app.firstWindow());
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('new-window').click());
    await windowsOf(app, 2);
    // Off macOS the last close quits Dolphin, which is not a Quit Dolphin started.
    const exited = process.platform === 'darwin' ? null : new Promise((resolve) => app.process().once('exit', resolve));
    await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.close(); });
    if (exited) await exited;
    else await sleep(1500);
    const saved = JSON.parse(readFileSync(path.join(profile, 'session.json'), 'utf8'));
    assert.deepEqual(saved.windows.map((window) => window.slot).sort(), [1, 2]);
  } finally {
    await teardown({ app, helpers: [[env.DOLPHIN_HOME, { env }]], remove: [home] });
  }
});
