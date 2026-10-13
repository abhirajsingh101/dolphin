// SSH agent forwarding: the keeper's ssh command, built without running ssh,
// and the keeper's lifecycle (agent-keeper.ts) with fake ssh processes. HOME is
// scratch so nothing is created under the real ~/.dolphin-desktop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

const scratchHome = mkdtempSync(path.join(tmpdir(), 'dagent-'));
process.env.HOME = scratchHome;
delete process.env.DOLPHIN_DESKTOP_SSH_OPTIONS;
const { agentKeeperArgs, sshArgs } = await import('../dist/sshArgs.js');
const { createAgentKeeper } = await import('../dist/agent-keeper.js');
test.after(() => rmSync(scratchHome, { recursive: true, force: true }));

const options = (args) => args.flatMap((arg, index) => (arg === '-o' ? [args[index + 1]] : []));
/** ssh keeps the first value it is given for each option. */
const first = (args, name) => options(args).find((option) => option.startsWith(`${name}=`));

test('the agent keeper is its own connection, carrying the agent and never prompting', () => {
  const args = agentKeeperArgs('gpu-box', '$HOME/.dolphin-server');
  const opts = options(args);
  for (const wanted of ['ForwardAgent=yes', 'BatchMode=yes', 'ControlMaster=no', 'ControlPath=none']) assert.ok(opts.includes(wanted), wanted);
  assert.ok(!opts.some((option) => option.startsWith('ControlPersist')));
  assert.ok(!opts.some((option) => option.startsWith('ControlPath=') && option !== 'ControlPath=none'));
  const at = args.indexOf('--');
  assert.deepEqual(args.slice(at + 1, at + 4), ['gpu-box', 'sh', '-c']);
  const script = args[at + 4];
  assert.match(script, /test -S "\$SSH_AUTH_SOCK"/);
  // Replaced atomically: a new link beside it, renamed over it (plain mv -f, not GNU -T),
  // so a session starting meanwhile never finds no link.
  assert.match(script, /ln -sfn "\$SSH_AUTH_SOCK" "\$HOME\/\.dolphin-server\/run\/\.agent\.sock\.\$\$" && mv -f "\$HOME\/\.dolphin-server\/run\/\.agent\.sock\.\$\$" "\$HOME\/\.dolphin-server\/run\/agent\.sock"/);
  assert.doesNotMatch(script, /ln -sfn "\$SSH_AUTH_SOCK" "[^"]*\/agent\.sock"/);
  assert.doesNotMatch(script, /mv -[a-zA-Z]*T/);
  // It holds the connection on its stdin, so it ends when ssh does (no pty, so
  // a `sleep` would get no SIGHUP and outlive every disconnect).
  assert.match(script, /exec cat >\/dev\/null/);
  assert.doesNotMatch(script, /sleep/);
});

test('the keeper stays unshared even when test options name a ControlPath', () => {
  process.env.DOLPHIN_DESKTOP_SSH_OPTIONS = '-o ControlPath=/tmp/scratch/%C';
  try {
    const keeper = agentKeeperArgs('gpu-box', '/srv/dolphin');
    assert.equal(first(keeper, 'ControlPath'), 'ControlPath=none');
    assert.equal(first(keeper, 'ControlMaster'), 'ControlMaster=no');
    assert.equal(first(sshArgs('gpu-box'), 'ControlPath'), 'ControlPath=/tmp/scratch/%C', 'shared commands keep the test path');
  } finally {
    delete process.env.DOLPHIN_DESKTOP_SSH_OPTIONS;
  }
});

test('ordinary commands still share the ControlMaster, and never forward the agent', () => {
  const opts = options(sshArgs('gpu-box', ['-N']));
  assert.ok(opts.includes('ControlMaster=auto'));
  assert.ok(opts.some((option) => option.startsWith('ControlPath=') && option !== 'ControlPath=none'));
  assert.equal(first(sshArgs('gpu-box'), 'ForwardAgent'), 'ForwardAgent=no');
});

/* --- lifecycle, with fake ssh processes ---------------------------------- */

/** A fake `ssh` keeper: says `ready` when told to, exits when killed. */
function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.kills = 0;
  child.exit = (code, signal = null) => {
    if (child.exitCode !== null || child.signalCode) return;
    child.exitCode = code;
    child.signalCode = signal;
    setImmediate(() => child.emit('exit', code, signal));
  };
  child.kill = (signal = 'SIGTERM') => { child.kills += 1; child.exit(null, signal); return true; };
  child.ready = () => child.stdout.write('rea') && child.stdout.write('dy\n');
  return child;
}

/** `link` models the machine's agent link: a keeper makes it when it says
 *  ready, unlink removes it a little later (an ssh round trip). */
function harness({ autoReady = true, readyMs } = {}) {
  const children = [];
  const unlinks = [];
  const reports = [];
  const state = { link: false };
  let closed = false;
  const keeper = createAgentKeeper({
    spawn: () => {
      const child = fakeChild();
      children.push(child);
      const ready = child.ready;
      child.ready = () => { state.link = true; return ready(); };
      if (autoReady) setImmediate(() => child.ready());
      return child;
    },
    unlink: async () => {
      unlinks.push(Date.now());
      await new Promise((resolve) => setTimeout(resolve, 20));
      state.link = false;
    },
    closed: () => closed,
    disconnected: () => new Error('gpu-box is disconnected.'),
    report: (error) => reports.push(error),
    readyMs,
  });
  const alive = () => children.filter((child) => child.exitCode === null && !child.signalCode);
  return { keeper, children, unlinks, reports, state, alive, close: () => { closed = true; keeper.close(); } };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('turning it on starts one keeper, and turning it on again reuses it', async () => {
  const h = harness();
  assert.deepEqual(await h.keeper.set(true), { ok: true });
  assert.deepEqual(await h.keeper.set(true), { ok: true });
  assert.equal(h.children.length, 1);
  assert.equal(h.alive().length, 1);
});

test('two toggles at once share one start', async () => {
  const h = harness();
  const [a, b] = await Promise.all([h.keeper.set(true), h.keeper.set(true)]);
  assert.deepEqual([a, b], [{ ok: true }, { ok: true }]);
  assert.equal(h.children.length, 1);
});

test('turning it off stops the keeper and removes the link', async () => {
  const h = harness();
  await h.keeper.set(true);
  assert.deepEqual(await h.keeper.set(false), { ok: true });
  assert.equal(h.alive().length, 0);
  assert.equal(h.unlinks.length, 1);
});

test('a keeper that fails says why, in ssh’s words', async () => {
  const h = harness({ autoReady: false });
  const result = h.keeper.set(true);
  await tick();
  h.children[0].stderr.write('No SSH agent reached the machine.\n');
  await tick();
  h.children[0].exit(3);
  assert.deepEqual(await result, { error: 'No SSH agent reached the machine.' });
});

test('a keeper that never says ready is stopped', async () => {
  const h = harness({ autoReady: false, readyMs: 30 });
  const result = await h.keeper.set(true);
  assert.match(result.error, /did not start/);
  await tick();
  assert.equal(h.alive().length, 0);
});

test('closing while the keeper starts stops it, and nothing starts after close', async () => {
  const h = harness({ autoReady: false });
  const result = h.keeper.set(true);
  await tick();
  assert.equal(h.alive().length, 1);
  h.close();
  assert.ok((await result).error, 'the start that was cut short reports it');
  await tick();
  assert.equal(h.alive().length, 0);
  h.keeper.restore();
  assert.deepEqual(await h.keeper.set(true), { error: 'gpu-box is disconnected.' });
  assert.equal(h.children.length, 1, 'no keeper spawned after close');
});

test('closing stops a running keeper', async () => {
  const h = harness();
  await h.keeper.set(true);
  h.close();
  await tick();
  assert.equal(h.alive().length, 0);
});

test('a reconnect replaces the keeper and never doubles it', async () => {
  const h = harness();
  await h.keeper.set(true);
  h.keeper.restore();
  h.keeper.restore();
  for (let i = 0; i < 5; i += 1) await tick();
  assert.equal(h.alive().length, 1);
  assert.equal(h.children.length, 3);
  assert.notEqual(h.alive()[0], h.children[0]);
  // A toggle that lands during a reconnect's start waits for it.
  h.keeper.restore();
  assert.deepEqual(await h.keeper.set(true), { ok: true });
  assert.equal(h.alive().length, 1);
});

test('a reconnect with forwarding off starts nothing', async () => {
  const h = harness();
  h.keeper.restore();
  await h.keeper.set(true);
  await h.keeper.set(false);
  h.keeper.restore();
  await tick();
  assert.equal(h.children.length, 1);
  assert.equal(h.alive().length, 0);
});

test('turning it off during a start stops that start', async () => {
  const h = harness({ autoReady: false });
  const on = h.keeper.set(true);
  await tick();
  assert.deepEqual(await h.keeper.set(false), { ok: true });
  await on;
  await tick();
  assert.equal(h.alive().length, 0);
});

test('turning it off and straight back on leaves the link in place', async () => {
  const h = harness();
  await h.keeper.set(true);
  const [off, on] = await Promise.all([h.keeper.set(false), h.keeper.set(true)]);
  assert.deepEqual([off, on], [{ ok: true }, { ok: true }]);
  for (let i = 0; i < 5; i += 1) await tick();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(h.state.link, true, 'the off’s rm ran before the on’s keeper made the link');
  assert.equal(h.alive().length, 1);
});

test('a keeper that stops by itself after starting says so', async () => {
  const h = harness();
  await h.keeper.set(true);
  h.children[0].exit(255);
  await tick();
  assert.deepEqual(h.reports, ['Agent forwarding stopped. Reconnect to restore it.']);
  // The reconnect that follows brings it back, and clears the message.
  h.keeper.restore();
  for (let i = 0; i < 5; i += 1) await tick();
  assert.deepEqual(h.reports, ['Agent forwarding stopped. Reconnect to restore it.', undefined]);
  assert.equal(h.alive().length, 1);
});

test('a keeper stopped by Dolphin itself reports nothing', async () => {
  const h = harness();
  await h.keeper.set(true);
  h.keeper.restore();
  for (let i = 0; i < 5; i += 1) await tick();
  await h.keeper.set(false);
  await h.keeper.set(true);
  h.close();
  for (let i = 0; i < 5; i += 1) await tick();
  assert.ok(h.reports.every((report) => report === undefined), JSON.stringify(h.reports));
});

test('a keeper’s error output is capped', async () => {
  const h = harness({ autoReady: false });
  const result = h.keeper.set(true);
  await tick();
  h.children[0].stderr.write('x'.repeat(100_000));
  await tick();
  h.children[0].exit(255);
  const { error } = await result;
  assert.ok(error.length > 0 && error.length <= 4096, String(error.length));
});
