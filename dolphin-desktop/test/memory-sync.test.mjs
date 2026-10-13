// The memory choice reaches every machine: on connect only an opt-in is sent,
// a change in Settings goes both ways, and 0.1.x installs start with it on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryChoiceFor, seededMemory, sendMemoryChoice } from '../dist/memorySync.js';

test('connecting only opts a machine in; a change in Settings goes both ways', () => {
  assert.equal(memoryChoiceFor('connected', true), true);
  assert.equal(memoryChoiceFor('connected', false), null);
  assert.equal(memoryChoiceFor('changed', true), true);
  assert.equal(memoryChoiceFor('changed', false), false);
});

test('the choice goes to the helper with its token', async () => {
  const calls = [];
  const ok = await sendMemoryChoice('http://127.0.0.1:5', 'tok', true, async (url, init) => { calls.push([url, init]); return { ok: true }; });
  assert.equal(ok, true);
  assert.deepEqual(calls, [['http://127.0.0.1:5/api/brain/consent', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dolphin-Token': 'tok' }, body: '{"enabled":true}',
  }]]);
});

test('an older helper (404) or a dropped link is reported, never thrown', async () => {
  assert.equal(await sendMemoryChoice('http://h', 't', true, async () => ({ ok: false })), false);
  assert.equal(await sendMemoryChoice('http://h', 't', false, async () => { throw new Error('ECONNRESET'); }), false);
});

test('a brain set up before 0.2.0 starts the setting on, once', () => {
  assert.equal(seededMemory({}, '{"state":"ready","version":"0.60.110.0"}'), true);
  assert.equal(seededMemory({}, '{"state":"failed"}'), null);
  assert.equal(seededMemory({}, null), null);
  assert.equal(seededMemory({}, 'not json'), null);
  assert.equal(seededMemory({ memory: false }, '{"state":"ready"}'), null, 'a recorded choice is never overridden');
});
