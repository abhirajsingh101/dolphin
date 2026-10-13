// Reading this computer's helper from its files: when it is ready, and when
// it is worth giving up at once, with the end of its log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { logTail, pidAlive, readServerInfo, waitForServer } from '../dist/local-helper.js';

const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;

function home(server, log) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dlh-'));
  mkdirSync(path.join(dir, 'run'), { recursive: true });
  mkdirSync(path.join(dir, 'logs'), { recursive: true });
  if (server) writeFileSync(path.join(dir, 'run', 'server.json'), JSON.stringify(server));
  if (log !== undefined) writeFileSync(path.join(dir, 'logs', 'helper.log'), log);
  return dir;
}

test('a ready helper whose pid lives and whose socket exists is used', async () => {
  const dir = home();
  const socket = path.join(dir, 'run', 'helper.sock');
  const listener = net.createServer().listen(socket);
  await new Promise((resolve) => listener.once('listening', resolve));
  try {
    writeFileSync(path.join(dir, 'run', 'server.json'), JSON.stringify({ state: 'ready', pid: process.pid, started_at: 2, socket }));
    assert.deepEqual(await waitForServer(dir, null, { timeoutMs: 1_000 }), { socket, pid: process.pid });
  } finally {
    listener.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a helper that failed while starting is reported at once, with the end of its log', async () => {
  const log = 'line 1\nTraceback (most recent call last):\nsqlite3.OperationalError: unable to open database file\n';
  const dir = home({ state: 'failed', pid: deadPid(), started_at: 2 }, log);
  try {
    const started = Date.now();
    await assert.rejects(waitForServer(dir, { state: 'ready', pid: 1, started_at: 1 }, { timeoutMs: 10_000 }), (error) => {
      assert.match(error.message, /^Dolphin's helper stopped while starting\./);
      assert.match(error.message, /helper\.log:\n[\s\S]*unable to open database file$/);
      return true;
    });
    assert.ok(Date.now() - started < 1_000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a starting helper whose pid died is reported at once', async () => {
  const dir = home({ state: 'starting', pid: deadPid(), started_at: 2 }, 'boom\n');
  try {
    await assert.rejects(waitForServer(dir, null, { timeoutMs: 10_000 }), /stopped while starting[\s\S]*boom/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a stale file from before this start is not mistaken for this start failing', async () => {
  const stale = { state: 'failed', pid: deadPid(), started_at: 1 };
  const dir = home(stale, '');
  try {
    await assert.rejects(waitForServer(dir, stale, { timeoutMs: 400, pollMs: 50 }), /did not start within 1 second\./);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('with no log at all the message says so', async () => {
  const dir = home({ state: 'failed', pid: deadPid(), started_at: 2 });
  try {
    await assert.rejects(waitForServer(dir, null, { timeoutMs: 1_000 }), /stopped while starting\. Its log \(.*helper\.log\) is empty or missing\./);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('older helpers without a state read as ready; the tail keeps the last lines', () => {
  const dir = home({ pid: 5, socket: '/tmp/x.sock' }, Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n') + '\n');
  try {
    assert.equal(readServerInfo(dir).state, 'ready');
    const tail = logTail(path.join(dir, 'logs', 'helper.log'), 3);
    assert.equal(tail, 'line 27\nline 28\nline 29');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed state fails at once even when its pid is alive', async () => {
  const dir = home({ state: 'failed', pid: process.pid, started_at: 2 }, 'bad config\n');
  try {
    const started = Date.now();
    await assert.rejects(waitForServer(dir, null, { timeoutMs: 10_000 }), /stopped while starting[\s\S]*bad config/);
    assert.ok(Date.now() - started < 1_000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the same pid with a new started_at is a fresh start', async () => {
  const dir = home({ state: 'failed', pid: process.pid, started_at: 2 }, 'x\n');
  try {
    await assert.rejects(waitForServer(dir, { state: 'ready', pid: process.pid, started_at: 1 }, { timeoutMs: 10_000 }), /stopped while starting/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pidAlive: a live pid owned by someone else (EPERM) is alive', { skip: process.getuid?.() === 0 }, () => {
  assert.equal(pidAlive(1), true);
  assert.equal(pidAlive(undefined), false);
});
