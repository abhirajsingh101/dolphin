// First run of the packaged app, as on a clean machine: an empty HOME, no
// DOLPHIN_* settings, no repository venv. The app must start its bundled
// helper, open the workspace with the first-run panel, set up its memory (a
// real GBrain install, so this needs the network), and show System Health.
// Runs when DOLPHIN_DESKTOP_APP is the packaged executable (CI sets it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { _electron as electron } from 'playwright';

const executable = process.env.DOLPHIN_DESKTOP_APP;
const shots = process.env.DOLPHIN_SHOTS || tmpdir();

function bundledHelper(exe) {
  const resources = process.platform === 'darwin'
    ? path.resolve(path.dirname(exe), '..', 'Resources')
    : path.join(path.dirname(exe), 'resources');
  return path.join(resources, 'helper', `${process.platform}-${process.arch}`, 'dolphin-helper', 'dolphin-helper');
}

test('the packaged app works on first run', { timeout: 480_000, skip: !executable && 'DOLPHIN_DESKTOP_APP is not set' }, async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'dclean-'));
  const helper = bundledHelper(executable);
  assert.ok(existsSync(helper), `no bundled helper at ${helper}`);
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('DOLPHIN_') && key !== 'TMUX' && key !== 'TMUX_PANE'));
  const env = { ...clean, HOME: home, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' };
  const app = await electron.launch({ executablePath: executable, args: process.platform === 'linux' ? ['--no-sandbox'] : [], env });
  try {
    const window = await app.firstWindow();
    await window.waitForURL(/app:\/\/dolphin\/desktop\.html/, { timeout: 120_000 });
    await window.getByRole('region', { name: 'Get started' }).getByRole('button', { name: 'Open Folder' }).waitFor({ timeout: 30_000 });
    await window.screenshot({ path: path.join(shots, 'packaged-first-run.png') });

    // Memory sets itself up in the background, then answers remember and recall.
    const memory = window.getByRole('region', { name: 'Memory' });
    await memory.getByText('Memory is ready').waitFor({ timeout: 300_000 });
    await window.screenshot({ path: path.join(shots, 'packaged-memory-ready.png') });
    const gbrain = realpathSync(path.join(home, '.dolphin-server', 'gbrain')); // the real path, as the helper uses
    const brain = (tool, args) => JSON.parse(execFileSync(path.join(gbrain, 'bun', 'bun'),
      [path.join(gbrain, 'runtime', 'node_modules', 'gbrain', 'src', 'cli.ts'), 'call', tool, JSON.stringify(args)],
      { env: { HOME: home, PATH: '/usr/bin:/bin', GBRAIN_HOME: path.join(gbrain, 'home') }, encoding: 'utf8' }).replace(/^[^{[]*/, ''));
    assert.equal(brain('remember', { fact: 'First-run test fact.', entity: 'user', provenance: 'packaged test' }).status, 'inserted');
    assert.equal(brain('recall', { query: 'first-run' }).facts[0].fact, 'First-run test fact.');

    await window.getByRole('link', { name: 'System Health' }).click();
    await window.getByText(/CPU/).first().waitFor({ timeout: 30_000 });
    await window.waitForTimeout(3000);
    await window.screenshot({ path: path.join(shots, 'packaged-health.png') });
    assert.doesNotMatch(await window.locator('body').innerText(), /Netdata is unavailable|Backend unavailable/);
    assert.ok(existsSync(path.join(home, '.dolphin-server', 'token')), 'the helper did not use ~/.dolphin-server');
  } finally {
    const exited = new Promise((resolve) => app.process().once('exit', resolve));
    await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined);
    await exited;
    try { execFileSync(helper, ['stop'], { env }); } catch { /* not running */ }
    rmSync(home, { recursive: true, force: true });
  }
});
