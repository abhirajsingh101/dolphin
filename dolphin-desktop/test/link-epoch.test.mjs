// The epoch a machine link carries: it moves whenever the page's terminals
// must reattach, and at no other time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextEpoch } from '../dist/link-epoch.js';

const at = (state, token = 't1', apiBase = 'http://127.0.0.1:4000') => ({ state, token, apiBase });

test('coming back to connected moves the epoch, from any state', () => {
  for (const from of ['connecting', 'reconnecting', 'offline', 'failed']) {
    assert.equal(nextEpoch(3, at(from), at('connected')), 4, from);
  }
});

test('a new token or address while connected moves it', () => {
  assert.equal(nextEpoch(3, at('connected'), at('connected', 't2')), 4);
  assert.equal(nextEpoch(3, at('connected'), at('connected', 't1', 'http://127.0.0.1:4001')), 4);
});

test('nothing else moves it', () => {
  assert.equal(nextEpoch(3, undefined, at('connecting')), 3);
  assert.equal(nextEpoch(3, at('connected'), at('connected')), 3);
  assert.equal(nextEpoch(3, at('connected'), at('reconnecting')), 3);
  assert.equal(nextEpoch(3, at('reconnecting'), at('offline')), 3);
});
