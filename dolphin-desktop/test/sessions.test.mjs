// First run and New Session → install a missing agent, against the real helper.
// HOME is scratch, tmux runs its own server under a scratch TMUX_TMPDIR, and
// `npm` is a fake that "installs" a fake codex, so nothing real is installed
// and the user's tmux server is never touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { _electron as electron } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const shots = process.env.DOLPHIN_SHOTS || tmpdir();

test('first run links a recent repo; New Session installs a missing agent and starts it', { timeout: 150_000 }, async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'dsess-'));
  const dolphinHome = path.join(home, '.dolphin-server');
  const tmuxDir = path.join(home, 'tmux');
  const fakeBin = path.join(home, 'fakebin');
  const project = path.join(home, 'demo');
  for (const dir of [tmuxDir, fakeBin, path.join(project, '.git')]) mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(fakeBin, 'npm'),
    `#!/bin/sh\necho "fake npm $*"\nprintf '#!/bin/sh\\necho FAKE-CODEX-READY\\nexec sleep 600\\n' > "${fakeBin}/codex"\nchmod +x "${fakeBin}/codex"\n`);
  chmodSync(path.join(fakeBin, 'npm'), 0o755);
  const { TMUX: _tmux, TMUX_PANE: _pane, ...inherited } = process.env;
  const env = {
    ...inherited, HOME: home, DOLPHIN_HOME: dolphinHome, TMUX_TMPDIR: tmuxDir, SHELL: '/bin/sh', DOLPHIN_WORKSPACE_ROOTS: home,
    PATH: `${fakeBin}:/usr/bin:/bin`, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', DOLPHIN_GBRAIN: 'off',
  };
  const socket = path.join(tmuxDir, `tmux-${process.getuid()}`, 'default');
  const tmux = (...args) => execFileSync('tmux', ['-S', socket, ...args], { env, encoding: 'utf8' });
  const app = await electron.launch({ args: ['--no-sandbox', `--user-data-dir=${path.join(home, 'profile')}`, root], env });
  try {
    const window = await app.firstWindow();
    await window.waitForURL(/desktop\.html/, { timeout: 90_000 });
    // First run: the start panel lists the git repo, and one click links it.
    const start = window.getByRole('region', { name: 'Get started' });
    const recent = start.getByRole('button', { name: /demo/ });
    await recent.waitFor({ timeout: 30_000 });
    await window.screenshot({ path: path.join(shots, 'desktop-start.png') });
    await recent.click();
    await start.waitFor({ state: 'detached', timeout: 15_000 });

    await window.locator('details', { hasText: 'demo' }).getByRole('button', { name: 'New session' }).click({ timeout: 30_000 });
    const dialog = window.getByRole('dialog', { name: 'New session in demo' });
    const install = dialog.getByRole('button', { name: /Install Codex/ });
    await install.waitFor({ timeout: 15_000 });
    assert.match(await install.innerText(), /npm install -g @openai\/codex/);
    assert.ok(await dialog.getByRole('button', { name: /Shell/ }).isVisible());
    await window.screenshot({ path: path.join(shots, 'desktop-new-session.png') });
    await install.click();
    await dialog.waitFor({ state: 'detached' });

    let pane = '';
    for (let i = 0; i < 40 && !pane.includes('FAKE-CODEX-READY'); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      try {
        const session = tmux('list-sessions', '-F', '#{session_name}').trim().split('\n')[0];
        pane = session ? tmux('capture-pane', '-p', '-t', session) : '';
      } catch { /* the server is still starting */ }
    }
    await window.screenshot({ path: path.join(shots, 'desktop-new-session-installed.png') });
    assert.match(pane, /fake npm install -g @openai\/codex/);
    assert.match(pane, /FAKE-CODEX-READY/);
  } finally {
    const exited = new Promise((resolve) => app.process().once('exit', resolve));
    await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined);
    await exited;
    try { execFileSync(path.resolve(root, '..', 'dolphin-backend', 'venv', 'bin', 'python'), ['-m', 'app.helper', 'stop'], { cwd: path.resolve(root, '..', 'dolphin-backend'), env }); } catch { /* not running */ }
    // This test's own tmux server, on its scratch socket; never the user's.
    try { tmux('kill-server'); } catch { /* none started */ }
    rmSync(home, { recursive: true, force: true });
  }
});
