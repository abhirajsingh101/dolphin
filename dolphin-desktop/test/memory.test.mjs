// Dolphin's memory for the agents: once memory is set up (a real GBrain
// install, so this needs the network), the app offers it to the installed
// agents, and Turn On registers it through their own `mcp add`. HOME is a
// scratch folder, so the user's real agent settings are never touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { _electron as electron } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const shots = process.env.DOLPHIN_SHOTS || tmpdir();
const has = (cli) => { try { execFileSync('sh', ['-c', `command -v ${cli}`]); return true; } catch { return false; } };

test('one Turn On gives the installed agents notifications and Dolphin\'s memory', { timeout: 300_000, skip: !has('claude') && !has('codex') }, async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'dmemo-'));
  const dolphinHome = path.join(home, '.dolphin-server');
  const { TMUX: _t, TMUX_PANE: _p, ...inherited } = process.env;
  const env = { ...inherited, HOME: home, DOLPHIN_HOME: dolphinHome, DOLPHIN_GBRAIN: 'auto', ELECTRON_DISABLE_SECURITY_WARNINGS: '1' };
  const app = await electron.launch({ args: ['--no-sandbox', `--user-data-dir=${path.join(home, 'profile')}`, root], env });
  try {
    const window = await app.firstWindow();
    await window.waitForURL(/desktop\.html/, { timeout: 90_000 });
    const prompt = window.getByRole('region', { name: 'Agent setup' });
    // Offered once memory is ready (it sets itself up on first start).
    await prompt.getByText(/share Dolphin’s memory/).waitFor({ timeout: 200_000 });
    await window.screenshot({ path: path.join(shots, 'desktop-memory-prompt.png') });
    await prompt.getByRole('button', { name: 'Turn On' }).click();
    await prompt.getByRole('status').waitFor({ timeout: 60_000 });
    assert.match(await prompt.getByRole('status').innerText(), /notifications are on, and they share Dolphin’s memory/);

    const launcher = path.join(dolphinHome, 'bin', 'dolphin-memory');
    assert.ok(existsSync(launcher));
    if (has('claude')) assert.match(readFileSync(path.join(home, '.claude.json'), 'utf8'), /"dolphin-memory"/);
    if (has('codex')) assert.match(readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8'), /mcp_servers\.dolphin-memory/);
  } finally {
    const exited = new Promise((resolve) => app.process().once('exit', resolve));
    await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined);
    await exited;
    try { execFileSync(path.resolve(root, '..', 'dolphin-backend', 'venv', 'bin', 'python'), ['-m', 'app.helper', 'stop'], { cwd: path.resolve(root, '..', 'dolphin-backend'), env }); } catch { /* not running */ }
    rmSync(home, { recursive: true, force: true });
  }
});
