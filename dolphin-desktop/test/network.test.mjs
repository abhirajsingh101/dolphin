// The network changing (Wi-Fi back, VPN up) tells the main process at once,
// which checks every machine link instead of waiting for the next check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchApp, quitApp, scratchEnv, stopHelper } from './support.mjs';

test('online and offline reach the main process', { timeout: 120_000 }, async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'dnet-'));
  const env = scratchEnv(home, { DOLPHIN_TMUX_IMPORT: 'off' });
  const app = await launchApp(home, env);
  try {
    const window = await app.firstWindow();
    await window.waitForURL(/desktop\.html/, { timeout: 90_000 });
    await app.evaluate(({ ipcMain }) => {
      globalThis.__networkChanges = [];
      ipcMain.on('dolphin:network-changed', (_event, kind) => globalThis.__networkChanges.push(kind));
    });
    await window.evaluate(() => { window.dispatchEvent(new Event('offline')); window.dispatchEvent(new Event('online')); });
    let heard = [];
    for (let i = 0; i < 40 && heard.length < 2; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      heard = await app.evaluate(() => globalThis.__networkChanges);
    }
    assert.deepEqual(heard, ['offline', 'online']);
    assert.equal(await window.evaluate(() => window.dolphinDesktop.machineList().find((m) => m.id === 'local').state), 'connected');
  } finally {
    await quitApp(app);
    await stopHelper(env.DOLPHIN_HOME, { env });
    rmSync(home, { recursive: true, force: true });
  }
});
