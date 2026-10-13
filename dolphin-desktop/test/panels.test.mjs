// The workflow panels in Dolphin Desktop, against the real helper on a
// scratch HOME and a scratch tmux server: Ports (this task), Usage and
// History (later tasks append here). Nothing real is read or started.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchApp, scratchEnv, teardown, tmuxFor } from './support.mjs';

const shots = process.env.DOLPHIN_SHOTS || tmpdir();

/** A scratch HOME with a git project `demo`, a fake `claude` that prints its
    arguments, and its own tmux server. `cleanup(app)` stops only what it started. */
function scratch() {
  const home = mkdtempSync(path.join(tmpdir(), 'dpan-'));
  const fakeBin = path.join(home, 'fakebin');
  const project = path.join(home, 'demo');
  for (const dir of [fakeBin, path.join(project, '.git')]) mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(fakeBin, 'claude'), '#!/bin/sh\necho "FAKE-CLAUDE $*"\nexec sleep 600\n');
  chmodSync(path.join(fakeBin, 'claude'), 0o755);
  const env = scratchEnv(home, { PATH: `${fakeBin}:/usr/bin:/bin` });
  const tmux = tmuxFor(env);
  const launch = () => launchApp(home, env);
  const cleanup = (app) => teardown({
    app,
    helpers: [[env.DOLPHIN_HOME]],
    // This test's own tmux server, on its scratch socket; never the user's.
    cleanup: [() => { try { tmux('kill-server'); } catch (error) { if (!/no server running|No such file/.test(String(error.stderr ?? error.message))) throw error; } }],
    remove: [home],
  });
  return { home, project, env, tmux, launch, cleanup };
}

/** The window, past the start panel, with `demo` linked as a project. */
async function workspaceWithDemo(app) {
  const window = await app.firstWindow();
  await window.waitForURL(/desktop\.html/, { timeout: 90_000 });
  await window.getByRole('region', { name: 'Get started' }).getByRole('button', { name: /demo/ }).click({ timeout: 30_000 });
  await window.locator('details', { hasText: 'demo' }).waitFor({ timeout: 15_000 });
  return window;
}

async function openMachinePanel(window, item) {
  await window.getByRole('button', { name: 'This Computer options' }).click();
  await window.getByRole('menuitem', { name: item }).click();
}

test('This Computer lists its listening ports and opens one in the browser', { timeout: 150_000 }, async () => {
  const box = scratch();
  const server = http.createServer((_request, response) => response.end('ok'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  let app;
  try {
    app = await box.launch();
    const window = await workspaceWithDemo(app);
    await app.evaluate(({ shell }) => { globalThis.__opened = []; shell.openExternal = async (url) => { globalThis.__opened.push(url); }; });
    await openMachinePanel(window, 'Ports…');
    const dialog = window.getByRole('dialog', { name: 'Ports on This Computer' });
    await dialog.getByRole('button', { name: `Open in browser: port ${port}` }).click({ timeout: 20_000 });
    await window.screenshot({ path: path.join(shots, 'desktop-ports.png') });
    for (let i = 0; i < 20 && !(await app.evaluate(() => globalThis.__opened)).length; i += 1) await new Promise((resolve) => setTimeout(resolve, 250));
    assert.deepEqual(await app.evaluate(() => globalThis.__opened), [`http://localhost:${port}/`]);
  } finally {
    server.close();
    await box.cleanup(app);
  }
});

test('Usage reads this computer’s Claude logs into a 5-hour window', { timeout: 150_000 }, async () => {
  const box = scratch();
  const folder = path.join(box.home, '.claude', 'projects', '-demo');
  mkdirSync(folder, { recursive: true });
  const at = new Date(Date.now() - 30 * 60_000).toISOString();
  writeFileSync(path.join(folder, 'a.jsonl'), `${JSON.stringify({ type: 'assistant', timestamp: at, requestId: 'r', message: { id: 'm', usage: { input_tokens: 1000, output_tokens: 500 } } })}\n`);
  let app;
  try {
    app = await box.launch();
    const window = await workspaceWithDemo(app);
    await openMachinePanel(window, 'Usage…');
    const dialog = window.getByRole('dialog', { name: 'Usage on This Computer' });
    await dialog.getByRole('region', { name: 'Claude Code' }).getByText(/^5-hour window: 1\.5k tokens/).waitFor({ timeout: 20_000 });
    await dialog.getByRole('region', { name: 'Codex' }).getByText('No Codex logs on This Computer.').waitFor();
    await window.screenshot({ path: path.join(shots, 'desktop-usage.png') });
  } finally {
    await box.cleanup(app);
  }
});

test('History finds a Claude transcript of the project and resumes it in a new session', { timeout: 150_000 }, async () => {
  const box = scratch();
  const id = '0b4c6a2e-1111-4222-8333-944445555666';
  const folder = path.join(box.home, '.claude', 'projects', box.project.replace(/[^A-Za-z0-9]/g, '-'));
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, `${id}.jsonl`), `${[
    { type: 'user', sessionId: id, cwd: box.project, timestamp: new Date().toISOString(), message: { role: 'user', content: 'Fix the login redirect' } },
    { type: 'assistant', sessionId: id, cwd: box.project, timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } },
  ].map((row) => JSON.stringify(row)).join('\n')}\n`);
  let app;
  try {
    app = await box.launch();
    const window = await workspaceWithDemo(app);
    await window.getByRole('button', { name: 'Session history for demo' }).click();
    const dialog = window.getByRole('dialog', { name: 'History of demo' });
    await dialog.getByRole('searchbox', { name: 'Search transcripts' }).fill('login');
    await dialog.getByRole('button', { name: 'Resume Fix the login redirect' }).click({ timeout: 20_000 });
    await window.screenshot({ path: path.join(shots, 'desktop-history.png') });
    let pane = '';
    for (let i = 0; i < 60 && !pane.includes('FAKE-CLAUDE'); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      try {
        const session = box.tmux('list-sessions', '-F', '#{session_name}').trim().split('\n')[0];
        pane = session ? box.tmux('capture-pane', '-p', '-t', session) : '';
      } catch { /* the server is still starting */ }
    }
    assert.match(pane, new RegExp(`FAKE-CLAUDE --resume ${id}`));
  } finally {
    await box.cleanup(app);
  }
});
