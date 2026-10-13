import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyWindowFlags, windowFlags } from '../dist/windowState.js';

const fake = (maximized = false, fullScreen = false) => {
  const calls = [];
  return { calls, isMaximized: () => maximized, isFullScreen: () => fullScreen, maximize: () => calls.push('maximize'), setFullScreen: (on) => calls.push(`fullscreen:${on}`) };
};

test('a live window reports its flags; a closed one keeps what was saved', () => {
  assert.deepEqual(windowFlags(fake(true, false)), { maximized: true, fullScreen: false });
  assert.deepEqual(windowFlags(null, { maximized: true, fullScreen: true }), { maximized: true, fullScreen: true });
  assert.deepEqual(windowFlags(null, { maximized: 'yes' }), { maximized: false, fullScreen: false });
});

test('a relaunch restores full screen first, otherwise maximized, otherwise nothing', () => {
  const full = fake(); applyWindowFlags(full, { maximized: true, fullScreen: true }); assert.deepEqual(full.calls, ['fullscreen:true']);
  const max = fake(); applyWindowFlags(max, { maximized: true }); assert.deepEqual(max.calls, ['maximize']);
  const plain = fake(); applyWindowFlags(plain, {}); assert.deepEqual(plain.calls, []);
});
