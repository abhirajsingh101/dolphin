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
    await window.screenshot({ path: path.join(shots, 'desktop-workspace.png') });

    await window.getByRole('link', { name: 'System Health' }).click();
    await window.getByRole('link', { name: /Back to Workspace/ }).waitFor();
    await window.getByText(/CPU/).first().waitFor({ timeout: 30_000 });
    await window.waitForTimeout(3000);
    await window.screenshot({ path: path.join(shots, 'desktop-health.png') });
    const bodyText = await window.locator('body').innerText();
    assert.doesNotMatch(bodyText, /Netdata is unavailable|Backend unavailable/);

    await window.getByRole('link', { name: /Back to Workspace/ }).click();
    await window.getByRole('textbox', { name: 'Message Dolphin' }).waitFor();
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
