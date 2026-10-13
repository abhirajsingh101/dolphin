// New Session in a worktree, end to end against the real helper. HOME is
// scratch, tmux runs its own server under a scratch TMUX_TMPDIR, and `claude`
// is a fake that prints its arguments, so nothing real runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { launchApp, scratchEnv, teardown, tmuxFor } from './support.mjs';

const shots = process.env.DOLPHIN_SHOTS || tmpdir();

test('a worktree session copies .env, runs setup, starts the agent, and archives once merged', { timeout: 180_000 }, async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'dwt-'));
  const fakeBin = path.join(home, 'fakebin');
  const repo = path.join(home, 'demo');
  for (const dir of [fakeBin, path.join(repo, '.dolphin')]) mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(fakeBin, 'claude'), '#!/bin/sh\necho "FAKE-CLAUDE $*"\nexec sleep 600\n');
  chmodSync(path.join(fakeBin, 'claude'), 0o755);
  const env = scratchEnv(home, {
    PATH: `${fakeBin}:/usr/bin:/bin`, GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
  });
  const git = (...args) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  writeFileSync(path.join(repo, 'README.md'), 'demo\n');
  writeFileSync(path.join(repo, '.gitignore'), '.env\nsetup-ran.txt\n');
  writeFileSync(path.join(repo, '.dolphin', 'setup'), '#!/bin/sh\necho ran > setup-ran.txt\n');
  chmodSync(path.join(repo, '.dolphin', 'setup'), 0o755);
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  writeFileSync(path.join(repo, '.env'), 'TOKEN=1\n');
  const tree = path.join(home, '.dolphin-worktrees', 'demo', 'dolphin-try');
  const tmux = tmuxFor(env);
  const app = await launchApp(home, env);
  try {
    const window = await app.firstWindow();
    await window.waitForURL(/desktop\.html/, { timeout: 90_000 });
    const start = window.getByRole('region', { name: 'Get started' });
    await start.getByRole('button', { name: /demo/ }).click({ timeout: 30_000 });
    await window.locator('details', { hasText: 'demo' }).getByRole('button', { name: 'New session' }).click({ timeout: 30_000 });
    const dialog = window.getByRole('dialog', { name: 'New session in demo' });
    await dialog.getByRole('checkbox', { name: 'In a new worktree' }).check({ timeout: 15_000 });
    await dialog.getByRole('textbox', { name: 'Branch' }).fill('dolphin/try');
    await dialog.getByText('Copies .env.').waitFor();
    assert.ok(await dialog.getByRole('checkbox', { name: 'Run .dolphin/setup first' }).isChecked());
    await window.screenshot({ path: path.join(shots, 'desktop-new-session-worktree.png') });
    await dialog.getByRole('button', { name: /Claude Code/ }).click();
    await dialog.waitFor({ state: 'detached' });

    let pane = '';
    for (let i = 0; i < 60 && !pane.includes('FAKE-CLAUDE'); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      try {
        const session = tmux('list-sessions', '-F', '#{session_name}').trim().split('\n')[0];
        pane = session ? tmux('capture-pane', '-p', '-t', session) : '';
      } catch { /* the server is still starting */ }
    }
    assert.match(pane, /FAKE-CLAUDE/);
    assert.equal(readFileSync(path.join(tree, '.env'), 'utf8'), 'TOKEN=1\n');
    assert.ok(existsSync(path.join(tree, 'setup-ran.txt')), '.dolphin/setup ran in the worktree');

    // Nothing committed: the branch is merged and clean, so it can be archived.
    const archive = window.getByRole('button', { name: /^Archive worktree / });
    await archive.waitFor({ timeout: 45_000 });
    await window.screenshot({ path: path.join(shots, 'desktop-worktree-archive.png') });
    await archive.click();
    await window.getByRole('button', { name: 'Archive', exact: true }).click();
    for (let i = 0; i < 40 && existsSync(tree); i += 1) await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(existsSync(tree), false, 'the worktree folder is gone');
    assert.match(git('branch', '--list', 'dolphin/try'), /dolphin\/try/);
    assert.ok(existsSync(path.join(repo, 'README.md')), 'the project folder is untouched');
  } finally {
    // The tmux server is this test's own, on its scratch socket; never the user's.
    await teardown({ app, helpers: [[env.DOLPHIN_HOME, { env }]], cleanup: [() => { try { tmux('kill-server'); } catch { /* none started */ } }], remove: [home] });
  }
});
