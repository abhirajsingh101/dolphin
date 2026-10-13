// Port-forward bookkeeping and loopback link rewriting, with a fake ssh; and
// the fallback forward's guard, with real ports and real child processes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { Forwards, cancelArgs, forwardArgs, holdForward, isLoopbackUrl, portIsFree, remotePortOf, rewriteToLocal, validPort, waitForPort } from '../dist/forwards.js';

function fakeOps(fail = () => false) {
  const calls = [];
  let next = 41000;
  return {
    calls,
    ops: {
      freePort: async () => next++,
      add: async (local, remote) => {
        calls.push(['add', local, remote]);
        if (fail(local, remote)) throw new Error('bind [127.0.0.1]:41000: Address already in use');
      },
      remove: async (local, remote) => { calls.push(['remove', local, remote]); },
    },
  };
}

test('a remote port is forwarded once and reused', async () => {
  const { calls, ops } = fakeOps();
  const forwards = new Forwards(ops);
  assert.equal(await forwards.open(3000), 41000);
  assert.equal(await forwards.open(3000), 41000);
  assert.equal(await forwards.open(5173), 41001);
  assert.deepEqual(calls, [['add', 41000, 3000], ['add', 41001, 5173]]);
  assert.deepEqual(forwards.list(), [{ remote: 3000, local: 41000 }, { remote: 5173, local: 41001 }]);
});

test('two opens of the same port at once share one forward', async () => {
  const { calls, ops } = fakeOps();
  const forwards = new Forwards(ops);
  const [a, b] = await Promise.all([forwards.open(3000), forwards.open(3000)]);
  assert.equal(a, 41000);
  assert.equal(b, 41000);
  assert.deepEqual(calls, [['add', 41000, 3000]]);
});

test('after a reconnect every forward comes back on the same local port', async () => {
  const { calls, ops } = fakeOps();
  const forwards = new Forwards(ops);
  await forwards.open(3000);
  calls.length = 0;
  await forwards.restore();
  assert.deepEqual(calls, [['add', 41000, 3000]]);
  assert.equal(await forwards.open(3000), 41000);
});

test('restore drops a forward whose local port is no longer free', async () => {
  let restoring = false;
  const { ops } = fakeOps((local) => restoring && local === 41000);
  const forwards = new Forwards(ops);
  await forwards.open(3000);
  restoring = true;
  await forwards.restore();
  assert.deepEqual(forwards.list(), []);
  restoring = false;
  assert.equal(await forwards.open(3000), 41001);
});

test('a forward that fails the first time is not remembered', async () => {
  const { ops } = fakeOps(() => true);
  const forwards = new Forwards(ops);
  await assert.rejects(forwards.open(3000), /Address already in use/);
  assert.deepEqual(forwards.list(), []);
});

test('closeAll removes every forward', async () => {
  const { calls, ops } = fakeOps();
  const forwards = new Forwards(ops);
  await forwards.open(3000);
  await forwards.open(8000);
  calls.length = 0;
  await forwards.closeAll();
  assert.deepEqual(calls, [['remove', 41000, 3000], ['remove', 41001, 8000]]);
  assert.deepEqual(forwards.list(), []);
});

test('only real TCP ports are forwarded', async () => {
  const forwards = new Forwards(fakeOps().ops);
  for (const bad of [0, -1, 1.5, 65536, Number.NaN]) {
    assert.equal(validPort(bad), false);
    await assert.rejects(forwards.open(bad), /not a TCP port/);
  }
});

test('loopback links are recognised and rewritten to the forwarded port', () => {
  for (const url of ['http://localhost:3000/x', 'http://127.0.0.1:8080', 'https://127.1.2.3/', 'http://[::1]:5173/', 'http://0.0.0.0:4000/']) {
    assert.ok(isLoopbackUrl(url), url);
  }
  for (const url of ['http://example.com:3000/', 'file:///etc/passwd', 'ftp://localhost/', 'not a url']) {
    assert.equal(isLoopbackUrl(url), false, url);
  }
  assert.equal(remotePortOf(new URL('http://localhost/')), 80);
  assert.equal(remotePortOf(new URL('https://localhost/')), 443);
  assert.equal(remotePortOf(new URL('http://localhost:3000/')), 3000);
  assert.equal(rewriteToLocal('http://localhost:3000/a?b=1#c', 41000), 'http://localhost:41000/a?b=1#c');
  assert.equal(rewriteToLocal('http://0.0.0.0:8080/', 41001), 'http://localhost:41001/');
  assert.equal(rewriteToLocal('http://[::1]:5173/', 41002), 'http://127.0.0.1:41002/');
  assert.equal(rewriteToLocal('http://127.0.0.1:5173/', 41003), 'http://127.0.0.1:41003/');
});

test('ssh -O arguments forward to the machine’s own loopback', () => {
  assert.deepEqual(forwardArgs(41000, 3000), ['-O', 'forward', '-L', '127.0.0.1:41000:127.0.0.1:3000']);
  assert.deepEqual(cancelArgs(41000, 3000), ['-O', 'cancel', '-L', '127.0.0.1:41000:127.0.0.1:3000']);
});

/* --- the fallback forward (an ssh of our own), against real ports --------- */

const listen = () => new Promise((resolve) => {
  const server = net.createServer((socket) => socket.end('not ours'));
  server.listen(0, '127.0.0.1', () => resolve(server));
});
const closeServer = (server) => new Promise((resolve) => server.close(resolve));
const exited = (child) => (child.exitCode !== null || child.signalCode ? Promise.resolve() : new Promise((resolve) => child.once('exit', resolve)));
/** A stand-in for `ssh -N -L`: node, told what to do. */
const node = (script) => spawn(process.execPath, ['-e', script], { stdio: 'ignore' });

test('a local port someone else holds is refused before any ssh starts', async () => {
  const server = await listen();
  const { port } = server.address();
  try {
    assert.equal(await portIsFree(port), false);
    let started = false;
    await assert.rejects(holdForward(port, () => { started = true; return node(''); }), /in use by another program/);
    assert.equal(started, false, 'no ssh was started for a port that is not ours');
  } finally {
    await closeServer(server);
  }
  assert.equal(await portIsFree(port), true);
});

test('an ssh that exits before its forward opens is a failure, even if the port later answers', async () => {
  const server = await listen();
  const { port } = server.address();
  await closeServer(server);
  // The child refuses its forward (ExitOnForwardFailure exits 255) and, after
  // it is gone, another program takes the port: that must not count as ours.
  let started;
  const child = new Promise((resolve) => { started = resolve; });
  const pending = holdForward(port, () => { const ssh = node('process.exit(255)'); started(ssh); return ssh; }, 5_000);
  pending.catch(() => undefined);
  await exited(await child);
  const thief = net.createServer().listen(port, '127.0.0.1');
  try {
    await assert.rejects(pending, /could not forward/i);
  } finally {
    await closeServer(thief);
  }
});

test('an ssh whose forward opens is held', async () => {
  const server = await listen();
  const { port } = server.address();
  await closeServer(server);
  const child = await holdForward(port, () => node(`require('node:net').createServer().listen(${port}, '127.0.0.1')`), 10_000);
  try {
    assert.equal(child.exitCode, null);
    assert.equal(await portIsFree(port), false);
  } finally {
    child.kill('SIGKILL');
    await exited(child);
  }
});

test('waitForPort gives up when nothing listens', async () => {
  const server = await listen();
  const { port } = server.address();
  await closeServer(server);
  await assert.rejects(waitForPort(port, 500), /did not open/);
});

/* --- review fixes: closing mid-flight, lost forwards, IPv6 ---------------- */

/** Fake ops whose `add` waits for a gate while `slow` is on; `live` is what
 *  would really be forwarded (held ssh children or master forwards). */
function gatedOps() {
  const live = new Set();
  const calls = [];
  let next = 41000;
  let slow = false;
  const gates = [];
  return {
    live, calls, gates,
    slow: (on) => { slow = on; },
    ops: {
      freePort: async () => next++,
      add: async (local, remote) => {
        calls.push(['add', local, remote]);
        if (slow) await new Promise((resolve) => gates.push(resolve));
        live.add(local);
      },
      remove: async (local, remote) => { calls.push(['remove', local, remote]); live.delete(local); },
    },
  };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('closing during a slow restore leaves no forward behind', async () => {
  const fake = gatedOps();
  const forwards = new Forwards(fake.ops);
  await forwards.open(3000);
  fake.live.clear(); // the link dropped: nothing is forwarded until restore
  fake.slow(true);
  const restoring = forwards.restore();
  await tick();
  await forwards.closeAll();
  for (const release of fake.gates) release();
  await restoring;
  assert.deepEqual([...fake.live], [], 'the forward restore made after closeAll was taken down');
  assert.deepEqual(forwards.list(), []);
});

test('closing during a slow open leaves no forward behind and the open fails', async () => {
  const fake = gatedOps();
  const forwards = new Forwards(fake.ops);
  fake.slow(true);
  const opening = forwards.open(3000);
  opening.catch(() => undefined);
  await tick();
  await forwards.closeAll();
  for (const release of fake.gates) release();
  await assert.rejects(opening, /closed/);
  assert.deepEqual([...fake.live], []);
  assert.deepEqual(forwards.list(), []);
});

test('restore asks for every forward at once', async () => {
  const fake = gatedOps();
  const forwards = new Forwards(fake.ops);
  await forwards.open(3000);
  await forwards.open(5173);
  fake.calls.length = 0;
  fake.slow(true);
  const restoring = forwards.restore();
  await tick();
  assert.deepEqual(fake.calls, [['add', 41000, 3000], ['add', 41001, 5173]], 'both before either finished');
  for (const release of fake.gates) release();
  await restoring;
});

test('a forward lost after it opened is made again (same port if free) before it is handed out', async () => {
  let refuse = false;
  const { calls, ops } = fakeOps((local) => refuse && local === 41000);
  const forwards = new Forwards(ops);
  await forwards.open(3000);
  forwards.lost(41000);
  calls.length = 0;
  assert.equal(await forwards.open(3000), 41000);
  assert.deepEqual(calls, [['add', 41000, 3000]]);
  // Lost again, and now the port is someone else's: a new one.
  forwards.lost(41000);
  refuse = true;
  assert.equal(await forwards.open(3000), 41001);
  assert.deepEqual(forwards.list(), [{ remote: 3000, local: 41001 }]);
});

test('a held ssh that fails after its forward opened is reported lost', async () => {
  const server = await listen();
  const { port } = server.address();
  await closeServer(server);
  let lost;
  const reported = new Promise((resolve) => { lost = resolve; });
  const child = await holdForward(port, () => node(`require('node:net').createServer().listen(${port}, '127.0.0.1'); setTimeout(() => process.exit(255), 300)`), 10_000, (code) => lost(code));
  const code = await Promise.race([reported, new Promise((resolve) => setTimeout(() => resolve('not reported'), 3_000))]);
  assert.equal(code, 255);
  await exited(child);
});

test('a port someone holds on ::1 is not free (a browser may try localhost there first)', async (t) => {
  const v4 = await listen();
  const { port } = v4.address();
  await closeServer(v4);
  const v6 = net.createServer();
  const bound = await new Promise((resolve) => { v6.once('error', () => resolve(false)); v6.listen(port, '::1', () => resolve(true)); });
  if (!bound) { t.skip('no IPv6 loopback here'); return; }
  try {
    assert.equal(await portIsFree(port), false);
  } finally {
    await closeServer(v6);
  }
});
