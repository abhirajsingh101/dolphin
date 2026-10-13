// Replacing an SSH forward: the old one is gone before the new one starts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TunnelSlot } from '../dist/tunnel.js';

function fakeChild(log, name) {
  return { name, exitCode: null, signalCode: null, kill() { log.push(`kill ${name}`); this.signalCode = 'SIGTERM'; return true; } };
}

test('replace kills the running tunnel before opening the next', () => {
  const log = [];
  const slot = new TunnelSlot();
  const first = slot.replace(() => { log.push('open first'); return fakeChild(log, 'first'); });
  const second = slot.replace(() => { log.push('open second'); return fakeChild(log, 'second'); });
  assert.deepEqual(log, ['open first', 'kill first', 'open second']);
  assert.equal(slot.isCurrent(first), false);
  assert.equal(slot.isCurrent(second), true);
});

test('a tunnel that already exited is not killed again; kill() empties the slot', () => {
  const log = [];
  const slot = new TunnelSlot();
  const first = slot.replace(() => fakeChild(log, 'first'));
  first.exitCode = 255;
  slot.replace(() => fakeChild(log, 'second'));
  assert.deepEqual(log, []);
  slot.kill();
  assert.deepEqual(log, ['kill second']);
  assert.equal(slot.current, null);
});

const stubborn = ['-e', "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000); console.log('up')"];
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('kill resolves only once a real child is gone, even if it ignores SIGTERM', async () => {
  const { spawn } = await import('node:child_process');
  const slot = new TunnelSlot();
  const child = slot.replace(() => spawn(process.execPath, stubborn, { stdio: ['ignore', 'pipe', 'ignore'] }));
  await new Promise((resolve) => child.stdout.once('data', resolve)); // handler installed
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('child survived kill')), 8000));
  try {
    await Promise.race([slot.kill(300), timeout]);
    assert.equal(alive(child.pid), false);
  } finally {
    if (alive(child.pid)) child.kill('SIGKILL');
  }
});

test('replace leaves no earlier real child running', async () => {
  const { spawn } = await import('node:child_process');
  const slot = new TunnelSlot();
  const old = slot.replace(() => spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' }));
  const exited = new Promise((resolve) => old.once('exit', resolve));
  slot.replace(() => spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' }));
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('old child survived')), 5000));
  try { await Promise.race([exited, timeout]); } finally { await slot.kill(300); }
});
