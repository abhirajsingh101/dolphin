// Closing the window (not Quit) must keep the machines that were open, and a
// saved place on a screen that is gone must not put the window off-screen.
// The remembered machine is unreachable on purpose (.invalid never resolves),
// with a scratch ssh config and known_hosts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SSH_TEST_OPTIONS, launchApp, scratchEnv, teardown } from './support.mjs';

test('closing the window keeps the open machines for the next launch; bounds stay on screen', { timeout: 150_000 }, async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'dpersist-'));
  const profile = path.join(home, 'profile');
  mkdirSync(profile, { recursive: true });
  writeFileSync(path.join(profile, 'session.json'), JSON.stringify({ machines: ['nohost.invalid'], bounds: { x: -20000, y: -20000, width: 1000, height: 700 } }));
  const env = scratchEnv(home, {
    DOLPHIN_TMUX_IMPORT: 'off',
    DOLPHIN_DESKTOP_SSH_OPTIONS: `${SSH_TEST_OPTIONS} -F /dev/null -o BatchMode=yes -o UserKnownHostsFile=${path.join(home, 'known_hosts')}`,
  });
  let app;
  try {
    app = await launchApp(home, env);
    const window = await app.firstWindow();
    await window.waitForURL(/desktop\.html/, { timeout: 90_000 });
    await window.waitForFunction(() => window.dolphinDesktop.machineList().some((m) => m.id === 'nohost.invalid' && m.state === 'failed'), null, { timeout: 60_000 });
    const { bounds, area } = await app.evaluate(({ BrowserWindow, screen }) => ({
      bounds: BrowserWindow.getAllWindows()[0].getBounds(), area: screen.getPrimaryDisplay().workArea,
    }));
    // At least 100x100 of the window is on the screen (a default-size window
    // centred on xvfb's 1280x1024 can hang over its edges; -20000 cannot).
    const visibleX = Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x);
    const visibleY = Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y);
    assert.ok(visibleX >= 100 && visibleY >= 100, `on screen: ${JSON.stringify({ bounds, area })}`);

    // Close the window, not Quit. On Linux that quits the app; on macOS the
    // app stays and a later Quit used to save an empty list.
    const exited = new Promise((resolve) => app.process().once('exit', resolve));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await exited;
    const saved = JSON.parse(readFileSync(path.join(profile, 'session.json'), 'utf8'));
    assert.deepEqual(saved.machines, ['nohost.invalid']);
  } finally {
    await teardown({ app, helpers: [[env.DOLPHIN_HOME, { env }]], remove: [home] });
  }
});

// macOS keeps Dolphin running with no window, and its machine links stay up
// (notifications still arrive). A Quit then saves those machines: the saved
// list is the live machines map whether or not a window is open.
test('close the window, connect nothing, quit: the machines are still saved', { timeout: 150_000 }, async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'dpersist-'));
  const profile = path.join(home, 'profile');
  const file = path.join(profile, 'session.json');
  mkdirSync(profile, { recursive: true });
  writeFileSync(file, JSON.stringify({ machines: ['nohost.invalid'] }));
  const env = scratchEnv(home, {
    DOLPHIN_TMUX_IMPORT: 'off',
    DOLPHIN_DESKTOP_SSH_OPTIONS: `${SSH_TEST_OPTIONS} -F /dev/null -o BatchMode=yes -o UserKnownHostsFile=${path.join(home, 'known_hosts')}`,
  });
  let app;
  try {
    app = await launchApp(home, env);
    const window = await app.firstWindow();
    await window.waitForURL(/desktop\.html/, { timeout: 90_000 });
    await window.waitForFunction(() => window.dolphinDesktop.machineList().some((m) => m.id === 'nohost.invalid'), null, { timeout: 60_000 });
    // Stay running with no window, as on macOS.
    await app.evaluate(async ({ app: electronApp, BrowserWindow }) => {
      electronApp.removeAllListeners('window-all-closed');
      const only = BrowserWindow.getAllWindows()[0];
      const closed = new Promise((resolve) => only.once('closed', resolve));
      only.close();
      await closed;
    });
    // The save at close is not what keeps them: the save at Quit is.
    rmSync(file, { force: true });
    const exited = new Promise((resolve) => app.process().once('exit', resolve));
    await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined);
    await exited;
    let saved = {};
    try { saved = JSON.parse(readFileSync(file, 'utf8')); } catch { /* not written */ }
    assert.deepEqual(saved.machines, ['nohost.invalid']);
  } finally {
    await teardown({ app, helpers: [[env.DOLPHIN_HOME, { env }]], remove: [home] });
  }
});
