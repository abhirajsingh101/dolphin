// The teardown every Electron test uses: it must never leave a helper running
// and never hang. Fake helpers here are plain node processes this test starts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { helperPid, quitApp, stopHelper, teardown } from './support.mjs';

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

function fakeHome(pid) {
  const home = mkdtempSync(path.join(tmpdir(), 'dsup-'));
  mkdirSync(path.join(home, 'run'), { recursive: true });
  writeFileSync(path.join(home, 'run', 'server.json'), JSON.stringify({ pid, state: 'ready' }));
  return home;
}

test('a helper that outlives a failed stop is killed by its exact pid, and the test fails loudly', async () => {
  // argv carries "dolphin-helper" so the identity check accepts it.
  const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'dolphin-helper'], { stdio: 'ignore' });
  const home = fakeHome(helper.pid);
  try {
    assert.equal(helperPid(home), helper.pid);
    await assert.rejects(stopHelper(home, { command: ['/bin/false'] }), /outlived `stop`/);
    for (let i = 0; i < 50 && alive(helper.pid); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(alive(helper.pid), false);
  } finally {
    if (alive(helper.pid)) helper.kill('SIGKILL');
    rmSync(home, { recursive: true, force: true });
  }
});

test('a helper that already stopped is fine', async () => {
  const gone = spawnSync(process.execPath, ['-e', '']).pid;
  const home = fakeHome(gone);
  try {
    await stopHelper(home, { command: ['/bin/true'] });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a pid that is not a Dolphin helper is never killed', async () => {
  const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const home = fakeHome(other.pid);
  try {
    await assert.rejects(stopHelper(home, { command: ['/bin/false'] }), /is not a Dolphin helper/);
    assert.equal(alive(other.pid), true);
  } finally {
    other.kill('SIGKILL');
    rmSync(home, { recursive: true, force: true });
  }
});

test('quitting an app that already exited returns at once; a hung one is killed', async () => {
  const exited = spawn(process.execPath, ['-e', '']);
  await new Promise((resolve) => exited.once('exit', resolve));
  await quitApp({ process: () => exited, evaluate: async () => undefined });

  const hung = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await assert.rejects(quitApp({ process: () => hung, evaluate: async () => undefined }, 300), /did not quit within 300 ms/);
  assert.notEqual(hung.signalCode ?? hung.exitCode, null);
});

test('a teardown whose first step throws still runs every later step, then throws an AggregateError', async () => {
  const hung = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'dolphin-helper'], { stdio: 'ignore' });
  const helperHome = fakeHome(hung.pid);
  const dir = mkdtempSync(path.join(tmpdir(), 'dsup-'));
  const ran = [];
  try {
    const failure = await teardown({
      app: { process: () => { throw new Error('app boom'); }, evaluate: async () => undefined },
      helpers: [[helperHome, { command: ['/bin/false'] }], [helperHome, { command: ['/bin/false'] }]],
      cleanup: [() => { ran.push('first'); throw new Error('cleanup boom'); }, () => { ran.push('second'); }],
      remove: [dir],
    }).then(() => null, (error) => error);
    assert.ok(failure instanceof AggregateError);
    assert.ok(failure.errors.length >= 3);
    assert.match(failure.errors[0].message, /app boom/);
    assert.deepEqual(ran, ['first', 'second']);
    assert.equal(alive(hung.pid), false);
    assert.equal(existsSync(dir), false);
  } finally {
    if (alive(hung.pid)) hung.kill('SIGKILL');
    rmSync(helperHome, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a teardown with nothing wrong resolves', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsup-'));
  await teardown({ remove: [dir] });
  assert.equal(existsSync(dir), false);
});

test('a cleanup entry that is not a function is rejected up front, naming it', async () => {
  let ran = false;
  await assert.rejects(
    teardown({ cleanup: [() => { ran = true; }, ['tmux', ['kill-server']]] }),
    (error) => error instanceof TypeError && /cleanup\[1\]/.test(error.message) && /function/.test(error.message),
  );
  assert.equal(ran, false, 'nothing runs when an entry is invalid');
});
