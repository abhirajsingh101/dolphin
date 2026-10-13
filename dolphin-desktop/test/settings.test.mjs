// Desktop settings (spec: "Settings"): <userData>/settings.json, read by the
// main process and reached by the page through dolphinDesktop.settings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_SETTINGS, onSettingsChange, patchIsValid, readRawSettings, readSettings, SETTINGS_FILE, writeSettings } from '../dist/settings.js';
import { launchApp, scratchEnv, teardown } from './support.mjs';

const defaults = { updateChannel: 'stable', memory: false, crashReports: 'local', agentForwarding: {} };

test('defaults when the file is missing, corrupt or not an object', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dset-'));
  try {
    assert.deepEqual(DEFAULT_SETTINGS, defaults);
    assert.deepEqual(readSettings(dir), defaults);
    for (const raw of ['{oops', '[]', '42']) {
      writeFileSync(path.join(dir, SETTINGS_FILE), raw);
      assert.deepEqual(readSettings(dir), defaults);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a patch keeps only valid fields, and the file survives a restart', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dset-'));
  try {
    const next = writeSettings(dir, { updateChannel: 'beta', memory: 'yes', crashReports: 'cloud', extra: 1 });
    assert.deepEqual(next, { ...defaults, updateChannel: 'beta' });
    assert.deepEqual(JSON.parse(readFileSync(path.join(dir, SETTINGS_FILE), 'utf8')), next);
    assert.deepEqual(writeSettings(dir, { memory: true }), { ...defaults, updateChannel: 'beta', memory: true });
    assert.deepEqual(readSettings(dir), { ...defaults, updateChannel: 'beta', memory: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('agentForwarding is an object of booleans, and nothing else', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dset-'));
  try {
    assert.deepEqual(writeSettings(dir, { agentForwarding: { 'box-a': true, 'box-b': false } }).agentForwarding, { 'box-a': true, 'box-b': false });
    for (const bad of [{ 'box-a': 'yes' }, [true], 'x', null, 3]) {
      assert.deepEqual(writeSettings(dir, { agentForwarding: bad }).agentForwarding, { 'box-a': true, 'box-b': false });
    }
    writeFileSync(path.join(dir, SETTINGS_FILE), JSON.stringify({ agentForwarding: { a: 1 } }));
    assert.deepEqual(readSettings(dir).agentForwarding, {});
    assert.equal(patchIsValid({ agentForwarding: { a: 'x' } }), false);
    assert.equal(patchIsValid({ memory: true, agentForwarding: { a: true } }), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('agentForwarding keys are machine ids; bad keys are dropped, and reject an IPC patch', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dset-'));
  try {
    const many = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`box-${i}`, true]));
    const bad = JSON.parse('{"__proto__":true,"constructor":true,"prototype":false,"-oProxy":true,"has space":true,"' + 'a'.repeat(300) + '":true,"local":true,"ssh://u@host:2222":false,"gpu-box":true}');
    assert.deepEqual(writeSettings(dir, { agentForwarding: bad }).agentForwarding, { local: true, 'ssh://u@host:2222': false, 'gpu-box': true });
    assert.equal(Object.getPrototypeOf(readSettings(dir).agentForwarding), Object.prototype);
    assert.deepEqual(writeSettings(dir, { agentForwarding: many }).agentForwarding, { local: true, 'ssh://u@host:2222': false, 'gpu-box': true }, 'over 200 keys is dropped whole');
    for (const key of ['__proto__', 'constructor', 'prototype', 'has space', 'a'.repeat(300)]) {
      assert.equal(patchIsValid({ agentForwarding: JSON.parse(`{${JSON.stringify(key)}:true}`) }), false, key.slice(0, 12));
    }
    assert.equal(patchIsValid({ agentForwarding: many }), false);
    assert.equal(patchIsValid({ agentForwarding: { local: true, 'gpu-box': false } }), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a patch must be an object whose known fields are all valid', () => {
  assert.equal(patchIsValid({ updateChannel: 'beta', bogus: true }), true);
  assert.equal(patchIsValid({ updateChannel: 'nightly' }), false);
  assert.equal(patchIsValid({ memory: true, crashReports: 'cloud' }), false);
  for (const bad of [null, undefined, [], 'x', 3]) assert.equal(patchIsValid(bad), false);
});

test('keys this version does not know stay in the file', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dset-'));
  try {
    writeFileSync(path.join(dir, SETTINGS_FILE), JSON.stringify({ later: { a: 1 }, memory: true }));
    assert.deepEqual(writeSettings(dir, { crashReports: 'off' }), { ...defaults, memory: true, crashReports: 'off' });
    assert.deepEqual(JSON.parse(readFileSync(path.join(dir, SETTINGS_FILE), 'utf8')).later, { a: 1 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('readRawSettings returns the file as is, or {} when it is missing, broken or not an object', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dset-'));
  try {
    assert.deepEqual(readRawSettings(dir), {});
    writeFileSync(path.join(dir, SETTINGS_FILE), JSON.stringify({ theme: 'dark', memory: 'yes' }));
    assert.deepEqual(readRawSettings(dir), { theme: 'dark', memory: 'yes' });
    for (const raw of ['{oops', '[1, 2]']) {
      writeFileSync(path.join(dir, SETTINGS_FILE), raw);
      assert.deepEqual(readRawSettings(dir), {});
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('invalid values fall back field by field', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dset-'));
  try {
    writeFileSync(path.join(dir, SETTINGS_FILE), JSON.stringify({ updateChannel: 'nightly', memory: 'yes', crashReports: 'off' }));
    assert.deepEqual(readSettings(dir), { ...DEFAULT_SETTINGS, crashReports: 'off' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a write tells listeners (next, previous) until they stop', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dset-'));
  const heard = [];
  const stop = onSettingsChange((next, previous) => heard.push([previous.updateChannel, next.updateChannel]));
  try {
    writeFileSync(path.join(dir, SETTINGS_FILE), JSON.stringify({ theme: 'dark' }));
    const next = writeSettings(dir, { updateChannel: 'beta' });
    assert.deepEqual(next, { ...DEFAULT_SETTINGS, updateChannel: 'beta' });
    assert.deepEqual(heard, [['stable', 'beta']]);
    assert.equal(readRawSettings(dir).theme, 'dark');
    stop();
    writeSettings(dir, { memory: true });
    assert.equal(heard.length, 1, 'a stopped listener hears nothing');
  } finally { stop(); rmSync(dir, { recursive: true, force: true }); }
});

test('an unwritable folder keeps what is on disk and does not throw', { skip: process.getuid?.() === 0 }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dset-'));
  try {
    writeSettings(dir, { crashReports: 'off' });
    chmodSync(dir, 0o500);
    assert.deepEqual(writeSettings(dir, { updateChannel: 'beta' }), { ...defaults, crashReports: 'off' });
  } finally { chmodSync(dir, 0o700); rmSync(dir, { recursive: true, force: true }); }
});

test('the page reads and writes settings through the preload', { timeout: 120_000 }, async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'dset-app-'));
  const profile = path.join(home, 'profile');
  let app;
  try {
    app = await launchApp(home, scratchEnv(home, { DOLPHIN_TMUX_IMPORT: 'off' }));
    const window = await app.firstWindow();
    await window.waitForURL(/app:\/\/dolphin\/desktop\.html/, { timeout: 90_000 });
    assert.deepEqual(await window.evaluate(() => window.dolphinDesktop.settings.get()), defaults);
    const saved = await window.evaluate(() => window.dolphinDesktop.settings.set({ updateChannel: 'beta', bogus: true }));
    assert.deepEqual(saved, { ...defaults, updateChannel: 'beta' });
    assert.deepEqual(JSON.parse(readFileSync(path.join(profile, 'settings.json'), 'utf8')), saved);
    assert.equal((await window.evaluate(() => window.dolphinDesktop.settings.get())).updateChannel, 'beta');
    // An invalid patch is rejected whole: the valid field in it is not applied.
    const kept = await window.evaluate(() => window.dolphinDesktop.settings.set({ memory: true, crashReports: 'cloud' }));
    assert.deepEqual(kept, saved);
    assert.deepEqual(await window.evaluate(() => window.dolphinDesktop.settings.get()), saved);
  } finally {
    await teardown({ app, helpers: [path.join(home, '.dolphin-server')], remove: [home] });
  }
});
