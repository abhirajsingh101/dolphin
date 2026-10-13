// This computer's helper dies (crash, OOM, killed): Dolphin notices, starts
// it again, moves the link's epoch, and the open terminal attaches again by
// itself. Everything is scratch: HOME, DOLPHIN_HOME, profile and tmux server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { helperPid, launchApp, scratchEnv, teardown, tmuxFor } from './support.mjs';

const pillIs = (window, state, timeout) => window.waitForFunction(
  (expected) => document.querySelector('.glass-terminal .connection-pill')?.getAttribute('aria-label') === `Terminal connection: ${expected}`,
  state, { timeout },
);

/** The pid is the helper this test started: its environment names this test's scratch home. */
function ownHelper(pid, home) {
  const environ = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
  return environ.includes(`DOLPHIN_HOME=${home}`);
}

// Proving the pid is this test's own helper needs /proc (Linux).
const skip = existsSync('/proc/self/environ') ? false : 'needs /proc to confirm the helper pid is this test\'s own';

test('the local helper dying is noticed; it restarts and the open terminal reattaches', { timeout: 180_000, skip }, async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'drec-'));
  mkdirSync(path.join(home, 'api', '.git'), { recursive: true });
  const env = scratchEnv(home);
  const tmux = tmuxFor(env);
  let app;
  try {
    tmux('new-session', '-d', '-s', 'api-work', '-c', path.join(home, 'api'));
    app = await launchApp(home, env);
    const window = await app.firstWindow();
    await window.waitForURL(/desktop\.html/, { timeout: 90_000 });
    await window.getByRole('button', { name: 'Open api / api-work' }).click({ timeout: 30_000 });
    await pillIs(window, 'live', 30_000);

    const local = () => window.evaluate(() => window.dolphinDesktop.machineList().find((m) => m.id === 'local'));
    const before = await local();
    await window.evaluate(() => { window.__states = []; window.dolphinDesktop.onMachineList((list) => window.__states.push(list.find((m) => m.id === 'local')?.state)); });
    const pid = helperPid(env.DOLPHIN_HOME);
    assert.ok(pid, 'the helper wrote its pid');
    assert.ok(ownHelper(pid, env.DOLPHIN_HOME), `pid ${pid} is this test's helper`);
    process.kill(pid, 'SIGKILL'); // this test's own helper, by its exact pid

    await window.waitForFunction(() => window.__states.includes('reconnecting') && window.__states.at(-1) === 'connected', null, { timeout: 60_000 });
    const after = await local();
    assert.ok(after.epoch > before.epoch, `epoch moved: ${before.epoch} → ${after.epoch}`);
    assert.notEqual(helperPid(env.DOLPHIN_HOME), pid);
    await pillIs(window, 'live', 30_000);

    // Keys reach tmux through the reattached socket.
    await window.locator('.glass-terminal .xterm-helper-textarea').focus();
    await window.keyboard.type('echo REATTACHED-OK');
    await window.keyboard.press('Enter');
    let pane = '';
    for (let i = 0; i < 40 && !pane.includes('REATTACHED-OK'); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      pane = tmux('capture-pane', '-p', '-t', 'api-work');
    }
    assert.match(pane, /REATTACHED-OK/);
  } finally {
    await teardown({
      app,
      helpers: [[env.DOLPHIN_HOME, { env }]],
      cleanup: [() => { try { tmux('kill-server'); } catch { /* this test's own scratch server (-S) only */ } }],
      remove: [home],
    });
  }
});
