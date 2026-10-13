// This computer's helper cannot start: the workspace still opens, This
// Computer shows the failure with Reconnect, nothing reaches :8400, and once
// the cause is gone Reconnect brings it back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchApp, quitApp, scratchEnv, stopHelper } from './support.mjs';

test('a broken local helper shows as a failed section, and Reconnect recovers it', { timeout: 180_000 }, async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'dfail-'));
  // A file where the helper's home folder should be: `serve` cannot create it.
  const blocker = path.join(home, 'helper-home');
  writeFileSync(blocker, '');
  const env = scratchEnv(home, { DOLPHIN_HOME: blocker, DOLPHIN_TMUX_IMPORT: 'off' });
  const app = await launchApp(home, env);
  try {
    const window = await app.firstWindow();
    await window.waitForURL(/desktop\.html/, { timeout: 90_000 });
    const section = window.getByRole('region', { name: 'This Computer projects' });
    await section.getByRole('alert').waitFor({ timeout: 60_000 });
    assert.equal(await window.evaluate(() => window.dolphinDesktop.machineList().find((m) => m.id === 'local').state), 'failed');
    assert.equal(await window.evaluate(() => performance.getEntriesByType('resource').some((entry) => entry.name.includes(':8400'))), false);

    rmSync(blocker);
    await section.getByRole('button', { name: 'Reconnect' }).click();
    await window.getByRole('textbox', { name: 'Message Dolphin' }).waitFor({ timeout: 90_000 });
    await window.waitForFunction(() => window.dolphinDesktop.machineList().find((m) => m.id === 'local')?.state === 'connected', null, { timeout: 60_000 });
    await window.waitForFunction(() => Boolean(window.dolphinDesktop.config), null, { timeout: 30_000 });
  } finally {
    await quitApp(app);
    await stopHelper(blocker, { env });
    rmSync(home, { recursive: true, force: true });
  }
});
