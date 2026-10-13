// One watchdog loop for every machine link, and the recovery loop behind it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRecovery, createWatchdog } from '../dist/watchdog.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('two missed checks in a row are a drop; a good check resets the count', async () => {
  const answers = [false, true, false, false];
  let drops = 0;
  const dog = createWatchdog({ check: async () => answers.shift() ?? true, intervalMs: 20, misses: 2, onDrop: () => { drops += 1; } });
  await sleep(200);
  dog.stop();
  assert.equal(drops, 1);
});

test('a check that throws counts as a miss', async () => {
  let drops = 0;
  const dog = createWatchdog({ check: async () => { throw new Error('ECONNREFUSED'); }, intervalMs: 20, misses: 2, onDrop: () => { drops += 1; } });
  await sleep(70);
  dog.stop();
  assert.ok(drops >= 1);
});

test('nothing is checked while paused, or after stop', async () => {
  let checks = 0;
  let paused = true;
  const dog = createWatchdog({ check: async () => { checks += 1; return false; }, intervalMs: 10, misses: 1, paused: () => paused, onDrop: () => undefined });
  await sleep(60);
  assert.equal(checks, 0);
  paused = false;
  await sleep(40);
  dog.stop();
  const seen = checks;
  await sleep(40);
  assert.ok(seen > 0);
  assert.equal(checks, seen);
});

test('checkNow after sleep: one failed check is enough', async () => {
  let drops = 0;
  const dog = createWatchdog({ check: async () => false, intervalMs: 60_000, misses: 2, onDrop: () => { drops += 1; } });
  dog.checkNow(1);
  await sleep(20);
  dog.stop();
  assert.equal(drops, 1);
});

test('a check that never settles is not a drop, and stop still ends the loop', async () => {
  let checks = 0;
  const dog = createWatchdog({ check: () => { checks += 1; return new Promise(() => undefined); }, intervalMs: 10, misses: 1, onDrop: () => assert.fail('no drop') });
  await sleep(50);
  dog.stop();
  assert.equal(checks, 1);
});

/* --- recovery ------------------------------------------------------------ */

const recovery = (overrides = {}) => {
  const states = [];
  let closed = false;
  const loop = createRecovery({
    attempt: async () => ({}), delayMs: () => 5, giveUpAfter: 3, closed: () => closed,
    onState: (state, info) => states.push([state, info.reason ?? null]), ...overrides,
  });
  return { loop, states, close: () => { closed = true; loop.wake(); } };
};

test('a recovery that succeeds says reconnecting, then connected, with what the attempt reported', async () => {
  const states = [];
  const { loop } = recovery({ attempt: async () => ({ tokenChanged: true }), onState: (state, info) => states.push([state, info.tokenChanged ?? null]) });
  await loop.run();
  assert.deepEqual(states, [['reconnecting', null], ['connected', true]]);
  assert.equal(loop.active, false);
});

test('two drops at once run one recovery, not two', async () => {
  let attempts = 0;
  const { loop } = recovery({ attempt: async () => { attempts += 1; await sleep(20); return {}; } });
  await Promise.all([loop.run(), loop.run(), loop.run()]);
  assert.equal(attempts, 1);
});

test('a helper that keeps failing ends offline with the reason, and waits for a wake instead of looping', async () => {
  let attempts = 0;
  let fail = true;
  const { loop, states, close } = recovery({ attempt: async () => { attempts += 1; if (fail) throw new Error(`boom ${attempts}`); return {}; } });
  const done = loop.run();
  await sleep(100);
  assert.equal(attempts, 3, 'stops trying after giveUpAfter attempts');
  assert.deepEqual(states.at(-1), ['offline', 'boom 3']);
  assert.equal(loop.active, true);
  fail = false;
  loop.wake(); // Reconnect
  await done;
  assert.equal(attempts, 4);
  assert.deepEqual(states.at(-1), ['connected', null]);
  close();
});

test('closing ends a recovery that is waiting, with no attempt after it', async () => {
  let attempts = 0;
  const { loop, close } = recovery({ attempt: async () => { attempts += 1; throw new Error('down'); }, delayMs: () => 60_000 });
  const done = loop.run();
  await sleep(20);
  close();
  await done;
  assert.equal(attempts, 1);
  assert.equal(loop.active, false);
});
