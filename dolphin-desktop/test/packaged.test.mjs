// First run of the packaged app, as on a clean machine: an empty HOME, no
// DOLPHIN_* settings, no repository venv. The app must start its bundled
// helper, open the workspace with the first-run panel, set up its memory (a
// real GBrain install, so this needs the network), and show System Health.
// Runs when DOLPHIN_DESKTOP_APP is the packaged executable (CI sets it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { _electron as electron } from 'playwright';
import { teardown } from './support.mjs';

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
  // A git repository to open, and a scratch tmux socket for its terminal.
  const tmuxDir = path.join(home, 'tmux');
  for (const dir of [path.join(home, 'demo', '.git'), tmuxDir]) mkdirSync(dir, { recursive: true });
  const helper = bundledHelper(executable);
  assert.ok(existsSync(helper), `no bundled helper at ${helper}`);
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('DOLPHIN_') && key !== 'TMUX' && key !== 'TMUX_PANE'));
  const env = { ...clean, HOME: home, TMUX_TMPDIR: tmuxDir, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' };
  let checkMemory = () => {};
  const app = await electron.launch({ executablePath: executable, args: [...(process.platform === 'linux' ? ['--no-sandbox'] : []), `--user-data-dir=${path.join(home, 'profile')}`], env });
  try {
    const window = await app.firstWindow();
    await window.waitForURL(/app:\/\/dolphin\/desktop\.html/, { timeout: 120_000 });
    await window.getByRole('region', { name: 'Get started' }).getByRole('button', { name: 'Open Folder' }).waitFor({ timeout: 30_000 });
    await window.screenshot({ path: path.join(shots, 'packaged-first-run.png') });
    // The whole screen, so the window's own controls (drawn outside the page) show too.
    if (process.platform === 'darwin') {
      try { execFileSync('screencapture', ['-x', path.join(shots, 'packaged-window.png')]); } catch { /* no screen access */ }
    }

    // Memory is opt-in: the checklist turns it on, then it sets itself up in
    // the background and answers remember and recall (checked after teardown stops the helper).
    await window.getByRole('region', { name: 'Setup checklist' }).getByRole('button', { name: 'Turn on memory' }).click();
    const memory = window.getByRole('region', { name: 'Memory' });
    try {
      await memory.getByText('Memory is ready').waitFor({ timeout: 300_000 });
    } catch (error) {
      // Setup runs in the helper: say what the panel and the helper's log said.
      const panel = await memory.innerText().catch(() => '(no Memory panel)');
      const tail = (file) => existsSync(file) ? readFileSync(file, 'utf8').split('\n').slice(-40).join('\n') : '(none)';
      const server = path.join(home, '.dolphin-server');
      await window.screenshot({ path: path.join(shots, 'packaged-memory-failed.png') }).catch(() => {});
      throw new Error(`${error.message}\nMemory panel: ${panel}`
        + `\nMemory install log:\n${tail(path.join(server, 'gbrain', 'install.log'))}`
        + `\nHelper log:\n${tail(path.join(server, 'logs', 'helper.log'))}`);
    }
    await window.screenshot({ path: path.join(shots, 'packaged-memory-ready.png') });
    const gbrain = realpathSync(path.join(home, '.dolphin-server', 'gbrain')); // the real path, as the helper uses
    const run = (tool, args) => JSON.parse(execFileSync(path.join(gbrain, 'bun', 'bun'),
      [path.join(gbrain, 'runtime', 'node_modules', 'gbrain', 'src', 'cli.ts'), 'call', tool, JSON.stringify(args)],
      { env: { HOME: home, PATH: '/usr/bin:/bin', GBRAIN_HOME: path.join(gbrain, 'home') }, encoding: 'utf8', stdio: 'pipe' }).replace(/^[^{[]*/, ''));
    // The helper's `gbrain serve` can take a moment to let the database go after the helper stops.
    const brain = (tool, args) => {
      for (let attempt = 1; ; attempt += 1) {
        try { return run(tool, args); } catch (error) {
          if (attempt === 15 || !/already open/.test(String(error.stderr ?? '') + String(error.stdout ?? '') + error.message)) throw error;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
        }
      }
    };
    // The helper keeps one `gbrain serve` holding the database while it runs,
    // so remember and recall run once the app and the helper have stopped.
    checkMemory = () => {
      assert.equal(brain('remember', { fact: 'First-run test fact.', entity: 'user', provenance: 'packaged test' }).status, 'inserted');
      assert.equal(brain('recall', { query: 'first-run' }).facts[0].fact, 'First-run test fact.');
    };

    // A project and a terminal, for the README's hero (scripts/make-hero.sh).
    const start = window.getByRole('region', { name: 'Get started' });
    await start.getByRole('button', { name: /demo/ }).click({ timeout: 30_000 });
    await start.waitFor({ state: 'detached', timeout: 15_000 });
    await window.locator('details', { hasText: 'demo' }).getByRole('button', { name: 'New session' }).click({ timeout: 30_000 });
    await window.getByRole('dialog', { name: 'New session in demo' }).getByRole('button', { name: /tmux Session/ }).click();
    await window.locator('.xterm').first().waitFor({ timeout: 30_000 });
    await window.waitForTimeout(2000);
    await window.screenshot({ path: path.join(shots, 'packaged-terminal.png') });

    await window.getByRole('link', { name: 'System Health' }).click();
    await window.getByText(/CPU/).first().waitFor({ timeout: 30_000 });
    await window.waitForTimeout(3000);
    await window.screenshot({ path: path.join(shots, 'packaged-health.png') });
    assert.doesNotMatch(await window.locator('body').innerText(), /Netdata is unavailable|Backend unavailable/);
    assert.ok(existsSync(path.join(home, '.dolphin-server', 'token')), 'the helper did not use ~/.dolphin-server');
  } finally {
    await teardown({ app, helpers: [[path.join(home, '.dolphin-server'), { command: [helper], cwd: undefined, env }]],
      // Only this test's tmux servers, each on an explicit socket under the scratch TMUX_TMPDIR.
      // The host tmux uses .../default; the bundled one (wrapper: -L dolphin) uses .../dolphin.
      cleanup: [() => checkMemory(), ...['default', 'dolphin'].map((name) => () => {
        const socket = path.join(tmuxDir, `tmux-${process.getuid()}`, name);
        const binary = name === 'dolphin' ? path.join(home, '.dolphin-server', 'bin', 'tmux') : 'tmux';
        try { execFileSync(binary, ['-S', socket, 'kill-server'], { env, encoding: 'utf8', stdio: 'pipe' }); } catch (error) {
          if (!/no server running|No such file|error connecting|ENOENT/.test(String(error.stderr ?? '') + String(error.message))) throw error;
        }
      })],
      remove: [home] });
  }
});
