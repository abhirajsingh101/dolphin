// What Dolphin remembers between launches, and when it may write it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { clampBounds, readJson, savedSystemNotifications, secondInstanceAction, sessionToSave, writeJsonAtomic } from '../dist/session-store.js';

test('writes are atomic and leave no temporary file behind', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dstore-'));
  try {
    const file = path.join(dir, 'session.json');
    writeJsonAtomic(file, { machines: ['gpu-box'] });
    writeJsonAtomic(file, { machines: ['gpu-box', 'build-01'] });
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { machines: ['gpu-box', 'build-01'] });
    assert.deepEqual(readdirSync(dir), ['session.json']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a truncated or foreign file reads as the fallback, never throws', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dstore-'));
  try {
    const file = path.join(dir, 'session.json');
    writeFileSync(file, '{"machines": ["gpu-');
    assert.deepEqual(readJson(file, {}), {});
    writeFileSync(file, '42');
    assert.deepEqual(readJson(file, {}), {});
    assert.deepEqual(readJson(path.join(dir, 'missing.json'), { recent: [] }), { recent: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('with no window, the machines are kept and the saved bounds stay', () => {
  const saved = { machines: ['gpu-box'], bounds: { x: 1, y: 2, width: 900, height: 600 } };
  // The window closed (macOS) and its machines are still connected: they are saved, in the last place.
  assert.deepEqual(sessionToSave(saved, { machines: ['gpu-box', 'build-01'] }), { machines: ['gpu-box', 'build-01'], bounds: saved.bounds });
  assert.deepEqual(sessionToSave(saved, { machines: ['build-01'] }), { machines: ['build-01'], bounds: saved.bounds });
  const bounds = { x: 5, y: 6, width: 1000, height: 700 };
  assert.deepEqual(sessionToSave(saved, { machines: [], bounds }), { machines: [], bounds });
});

test('bounds come back on a screen that is attached', () => {
  const laptop = { x: 0, y: 0, width: 1440, height: 900 };
  const external = { x: 1440, y: 0, width: 2560, height: 1440 };
  // Still attached: kept as it was.
  assert.deepEqual(clampBounds({ x: 1600, y: 100, width: 1200, height: 800 }, [laptop, external]), { x: 1600, y: 100, width: 1200, height: 800 });
  // The external screen is gone: nothing usable is visible, so the default place.
  assert.equal(clampBounds({ x: 1600, y: 100, width: 1200, height: 800 }, [laptop]), undefined);
  // Hanging off an edge, or larger than the screen: pulled inside it.
  assert.deepEqual(clampBounds({ x: 1000, y: -50, width: 800, height: 600 }, [laptop]), { x: 640, y: 0, width: 800, height: 600 });
  assert.deepEqual(clampBounds({ x: 0, y: 0, width: 3000, height: 2000 }, [laptop]), { x: 0, y: 0, width: 1440, height: 900 });
  assert.equal(clampBounds(undefined, [laptop]), undefined);
  assert.equal(clampBounds({ x: 0, y: 0, width: 800, height: 600 }, []), undefined);
});

test('a second launch shows the window, or restores it when there is none', () => {
  assert.equal(secondInstanceAction(true, true), 'show');
  assert.equal(secondInstanceAction(true, false), 'restore');
  assert.equal(secondInstanceAction(false, false), 'wait');
});

test('a failed write removes its temporary file and keeps the old content', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dstore-'));
  try {
    const file = path.join(dir, 'session.json');
    writeJsonAtomic(file, { machines: ['gpu-box'] });
    // BigInt makes JSON.stringify throw after the temporary file is open.
    assert.throws(() => writeJsonAtomic(file, { n: 1n }));
    assert.deepEqual(readdirSync(dir), ['session.json']);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { machines: ['gpu-box'] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an array is not an object: readJson returns the fallback', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dstore-'));
  try {
    const file = path.join(dir, 'a.json');
    writeFileSync(file, '["x"]');
    assert.deepEqual(readJson(file, { recent: [] }), { recent: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the system-notifications setting survives a save and is read at startup', () => {
  // Off in the profile: off from launch, before the page sends anything.
  assert.equal(savedSystemNotifications({ systemNotifications: false }), false);
  assert.equal(savedSystemNotifications({ systemNotifications: true }), true);
  // Never set, or not a boolean: on (the renderer's default).
  assert.equal(savedSystemNotifications({}), true);
  assert.equal(savedSystemNotifications({ systemNotifications: 'no' }), true);
  // A session save keeps it.
  assert.deepEqual(sessionToSave({ machines: [], systemNotifications: false }, { machines: ['gpu-box'] }), { machines: ['gpu-box'], bounds: undefined, systemNotifications: false });
});

test('the maximized and full-screen flags are saved, and kept when the window is gone', () => {
  const bounds = { x: 5, y: 6, width: 1000, height: 700 };
  const flags = { maximized: true, fullScreen: false };
  assert.deepEqual(sessionToSave({ machines: [] }, { machines: ['gpu-box'], bounds, flags }), { machines: ['gpu-box'], bounds, maximized: true, fullScreen: false });
  const saved = { machines: [], bounds, maximized: true, fullScreen: true, systemNotifications: false };
  assert.deepEqual(sessionToSave(saved, { machines: ['gpu-box'] }), { machines: ['gpu-box'], bounds, maximized: true, fullScreen: true, systemNotifications: false });
  assert.deepEqual(sessionToSave(saved, { machines: [], bounds, flags: { maximized: false, fullScreen: false } }), { machines: [], bounds, maximized: false, fullScreen: false, systemNotifications: false });
});
