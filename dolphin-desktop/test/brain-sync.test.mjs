// Every machine's work comes home to this computer's brain: each export goes
// to this computer's helper, labelled with its machine, and a cursor moves on
// only once the export was taken.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncAll, syncMachine } from '../dist/brainSync.js';

const local = { apiBase: 'http://local', token: 'lt' };
const remote = { id: 'gpu-box', kind: 'ssh', endpoint: { apiBase: 'http://remote', token: 'rt' } };
const reply = (status, body = {}) => ({ ok: status < 300, status, json: async () => body });

function fakeFetch(exports, importStatus = 200) {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    if (url.startsWith('http://remote/api/brain/export') || url.startsWith('http://local/api/brain/export')) {
      return reply(200, exports.shift());
    }
    if (url === 'http://local/api/brain/import') return reply(importStatus, { pending: 0, busy: false });
    throw new Error(`unexpected ${url}`);
  };
  return { calls, fetcher };
}

test('a machine is exported page by page into this computer with its own label', async () => {
  const { calls, fetcher } = fakeFetch([
    { hostname: 'gpu', projects: [], cursor: { turns: 1 }, has_more: true },
    { hostname: 'gpu', projects: [], cursor: { turns: 2 }, has_more: false },
  ]);
  const result = await syncMachine(remote, local, { turns: 0 }, fetcher);
  assert.deepEqual(result, { cursor: { turns: 2 }, rounds: 2, busy: false });
  const first = new URL(calls[0].url);
  assert.equal(first.searchParams.get('cursor'), '{"turns":0}');
  assert.equal(first.searchParams.get('brain_pages'), null);  // machines have no brains of their own
  assert.equal(calls[0].init.headers['X-Dolphin-Token'], 'rt');
  assert.equal(new URL(calls[2].url).searchParams.get('cursor'), '{"turns":1}');
  const sent = JSON.parse(calls[1].init.body);
  assert.deepEqual(sent.machine, { id: 'gpu-box', label: 'gpu-box', kind: 'ssh' });
  assert.equal(calls[1].init.headers['X-Dolphin-Token'], 'lt');
});

test('this computer sends its work under its hostname and keeps its own brain', async () => {
  const { calls, fetcher } = fakeFetch([{ hostname: 'studio-mac', cursor: { turns: 1 } }]);
  await syncMachine({ id: 'local', kind: 'local', endpoint: local }, local, undefined, fetcher);
  assert.deepEqual(JSON.parse(calls[1].init.body).machine, { id: 'studio-mac', label: 'studio-mac', kind: 'local' });
});

test('a cursor stays put when this computer did not take the export', async () => {
  const off = fakeFetch([{ cursor: { turns: 9 } }], 409);
  assert.deepEqual(await syncMachine(remote, local, { turns: 1 }, off.fetcher), { cursor: { turns: 1 }, rounds: 0, stopped: 'memory-off' });
  const broken = fakeFetch([{ cursor: { turns: 9 } }], 500);
  const result = await syncMachine(remote, local, { turns: 1 }, broken.fetcher);
  assert.equal(result.stopped, 'failed');
  assert.deepEqual(result.cursor, { turns: 1 });
  const unreachable = await syncMachine(remote, local, { turns: 1 }, async () => { throw new Error('ECONNRESET'); });
  assert.equal(unreachable.stopped, 'failed');
  assert.deepEqual(unreachable.cursor, { turns: 1 });
});

test('every machine is synced in turn and each cursor is kept as it moves', async () => {
  const { fetcher } = fakeFetch([{ hostname: 'mac', cursor: { a: 1 } }, { hostname: 'gpu', cursor: { b: 1 } }]);
  const saved = [];
  const cursors = {};
  await syncAll([{ id: 'local', kind: 'local', endpoint: local }, remote], local, cursors, (next) => saved.push(structuredClone(next)), fetcher);
  assert.deepEqual(cursors, { local: { a: 1 }, 'gpu-box': { b: 1 } });
  assert.deepEqual(saved, [{ local: { a: 1 } }, { local: { a: 1 }, 'gpu-box': { b: 1 } }]);
});
