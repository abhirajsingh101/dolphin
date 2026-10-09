// The one-time "turn on agent notifications" line, against the real helper.
// HOME is a scratch folder, so the user's real Claude/Codex settings are never touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { _electron as electron } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const shots = process.env.DOLPHIN_SHOTS || tmpdir();
const has = (cli) => { try { execFileSync('sh', ['-c', `command -v ${cli}`]); return true; } catch { return false; } };

test('Turn On adds Dolphin\'s hook for the agents installed here', { timeout: 120_000, skip: !has('claude') && !has('codex') }, async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'dhome-'));
  const dolphinHome = path.join(home, '.dolphin-server');
  const app = await electron.launch({
    args: ['--no-sandbox', root],
    env: { ...process.env, HOME: home, DOLPHIN_HOME: dolphinHome, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', DOLPHIN_GBRAIN: 'off' },
  });
  try {
    const window = await app.firstWindow();
    await window.waitForURL(/desktop\.html/, { timeout: 90_000 });
    const prompt = window.getByRole('region', { name: 'Agent setup' });
    await prompt.getByRole('button', { name: 'Turn On' }).waitFor({ timeout: 30_000 });
    await window.screenshot({ path: path.join(shots, 'desktop-hooks-prompt.png') });
    await prompt.getByRole('button', { name: 'Turn On' }).click();
    await prompt.getByRole('status').waitFor();
    assert.match(await prompt.getByRole('status').innerText(), /notifications are on/);
    const shim = path.join(dolphinHome, 'bin', 'dolphin-hook');
    if (has('claude')) assert.match(readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'), new RegExp(`${shim} --provider claude --event stop`));
    if (has('codex')) {
      assert.match(readFileSync(path.join(home, '.codex', 'hooks.json'), 'utf8'), /--provider codex --event stop/);
      assert.match(readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8'), /hooks = true/);
    }
    assert.ok(existsSync(shim));
  } finally {
    const exited = new Promise((resolve) => app.process().once('exit', resolve));
    await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined);
    await exited;
    try { execFileSync(path.resolve(root, '..', 'dolphin-backend', 'venv', 'bin', 'python'), ['-m', 'app.helper', 'stop'], { cwd: path.resolve(root, '..', 'dolphin-backend'), env: { ...process.env, HOME: home, DOLPHIN_HOME: dolphinHome } }); } catch { /* not running */ }
    rmSync(home, { recursive: true, force: true });
  }
});
