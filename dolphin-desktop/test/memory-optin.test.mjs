// Memory is opt-in (0.2.0): the helper downloads nothing until the user turns
// memory on in Dolphin Desktop, and the choice reaches the helper from the
// main process. A fake curl (fakeGbrainDownloads) fails every download, so turning it on never
// fetches the real 400 MB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fakeGbrainDownloads, launchApp, quitApp, scratchEnv, stopHelper, teardown } from './support.mjs';

test('turning memory on and off reaches this computer\'s helper', { timeout: 200_000 }, async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'dmem-'));
  const dolphinHome = path.join(home, '.dolphin-server');
  const profile = path.join(home, 'profile');
  fakeGbrainDownloads(dolphinHome);
  const env = scratchEnv(home, { DOLPHIN_GBRAIN: 'ask', DOLPHIN_TMUX_IMPORT: 'off' });
  const consentFile = path.join(dolphinHome, 'gbrain', 'consent.json');
  const consent = () => {
    try { return JSON.parse(readFileSync(consentFile, 'utf8')).memory; } catch (error) {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    }
  };
  const until = async (check, what) => {
    for (let i = 0; i < 80; i += 1) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 250)); }
    assert.fail(what);
  };
  const launch = async () => {
    const app = await launchApp(home, env);
    const window = await app.firstWindow();
    await window.waitForURL(/desktop\.html/, { timeout: 90_000 });
    return { app, window };
  };
  let app;
  try {
    let window;
    ({ app, window } = await launch());
    await window.waitForTimeout(1500);
    assert.equal(consent(), undefined, 'nothing is chosen for the user');
    await window.evaluate(() => window.dolphinDesktop.settings.set({ memory: true }));
    await until(() => consent() === true, 'memory on never reached the helper');
    await window.evaluate(() => window.dolphinDesktop.settings.set({ memory: false }));
    await until(() => consent() === false, 'memory off never reached the helper');
    await quitApp(app);
    app = undefined;
    await stopHelper(dolphinHome);
    // Next launch with the setting on: connecting opts this computer in again.
    rmSync(consentFile);
    writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ memory: true }));
    ({ app } = await launch());
    await until(() => consent() === true, 'connecting did not send the choice');
  } finally {
    await teardown({ app, helpers: [dolphinHome], remove: [home] });
  }
});
