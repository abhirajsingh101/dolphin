// A finished turn raises a system notification from the main process while the
// window is not focused, and a click opens that session. Real helper; HOME,
// DOLPHIN_HOME and the tmux server (TMUX_TMPDIR) are scratch, and Electron's
// Notification is replaced inside the app, so nothing reaches the desktop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchApp, scratchEnv, teardown, tmuxFor } from './support.mjs';

function nudge(dolphinHome) {
  const { socket } = JSON.parse(readFileSync(path.join(dolphinHome, 'run', 'server.json'), 'utf8'));
  const token = readFileSync(path.join(dolphinHome, 'token'), 'utf8').trim();
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath: socket, path: '/api/desktop/turn-nudge', method: 'POST', headers: { 'X-Dolphin-Token': token } },
      (response) => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
    request.on('error', reject);
    request.end();
  });
}

test('a finished turn notifies while the window is hidden; clicking it opens the session', { timeout: 150_000 }, async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'dnote-'));
  const project = path.join(home, 'demo');
  mkdirSync(path.join(project, '.git'), { recursive: true });
  const env = scratchEnv(home);
  const tmux = tmuxFor(env);
  tmux('new-session', '-d', '-s', 'build', '-c', project);
  let app;
  try {
    app = await launchApp(home, env);
    const window = await app.firstWindow();
    await window.waitForURL(/desktop\.html/, { timeout: 90_000 });
    // The running session's folder became a project (tmux import), so the turn has somewhere to open.
    await window.getByRole('button', { name: 'Open demo / build', exact: true }).waitFor({ timeout: 60_000 });
    await app.evaluate(({ BrowserWindow, Notification }) => {
      globalThis.shown = [];
      Notification.isSupported = () => true;
      Notification.prototype.show = function show() { globalThis.shown.push(this); };
      BrowserWindow.getAllWindows()[0].hide();
    });
    const pane = tmux('display-message', '-p', '-t', 'build:0.0', '#{pane_id}').trim();
    tmux('set-option', '-p', '-t', pane, '@dolphin-turn', JSON.stringify({
      id: randomUUID().replace(/-/g, ''), provider: 'claude', finished_at: new Date().toISOString(), summary: '**Done.** Ported `index.ts`.',
    }));
    assert.equal(await nudge(env.DOLPHIN_HOME), 204);
    let shown = [];
    for (let i = 0; i < 100 && shown.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      shown = await app.evaluate(() => globalThis.shown.map((popup) => ({ title: popup.title, body: popup.body })));
    }
    assert.deepEqual(shown, [{ title: 'build · demo', body: 'Done. Ported index.ts.' }]);
    await app.evaluate(() => globalThis.shown[0].emit('click'));
    await window.getByRole('heading', { name: 'demo / build' }).waitFor({ timeout: 15_000 });
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), true);
  } finally {
    await teardown({
      app,
      helpers: [[env.DOLPHIN_HOME, { env }]],
      // This test's own tmux server, by its scratch socket: end its one session; an empty server exits.
      cleanup: [() => { try { tmux('kill-session', '-t', '=build'); } catch { /* already gone */ } }],
      remove: [home],
    });
  }
});
