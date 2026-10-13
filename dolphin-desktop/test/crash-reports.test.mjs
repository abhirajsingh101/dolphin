// Crash reports stay on this computer: on by default, never uploaded, off when
// the setting says so, and one menu item away. Each crash case crashes a scratch
// app on a scratch HOME and --user-data-dir; nothing it starts may outlive it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CRASH_DIR, crashReporterOptions } from '../dist/crashReports.js';
import { launchApp, scratchEnv, teardown } from './support.mjs';

const dumps = (dir) => { try { return readdirSync(dir, { recursive: true }).filter((name) => String(name).endsWith('.dmp')); } catch { return []; } };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Kill only processes whose command line names this test's own profile
 *  (a crashed Electron's crashpad_handler can outlive it), by exact pid. */
function killLeftovers(profile) {
  const out = spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' }).stdout ?? '';
  for (const line of out.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match && match[2].includes(profile) && Number(match[1]) !== process.pid) {
      try { process.kill(Number(match[1]), 'SIGKILL'); } catch { /* already gone */ }
    }
  }
}
const leftovers = (profile) => (spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' }).stdout ?? '')
  .split('\n').filter((line) => line.includes(profile) && !/\bps -eo\b/.test(line));

test('local reports are never uploaded; off starts nothing', () => {
  const options = crashReporterOptions('local');
  assert.deepEqual(options, { uploadToServer: false, compress: true });
  assert.equal('submitURL' in options, false);
  assert.equal(crashReporterOptions('off'), null);
  assert.equal(CRASH_DIR, 'Crash Reports');
});

async function crash(settings) {
  const home = mkdtempSync(path.join(tmpdir(), 'dcrash-'));
  const profile = path.join(home, 'profile');
  mkdirSync(profile, { recursive: true });
  if (settings) writeFileSync(path.join(profile, 'settings.json'), JSON.stringify(settings));
  const env = scratchEnv(home);
  const app = await launchApp(home, env);
  const result = { home, profile, env, app };
  try {
    const window = await app.firstWindow();
    await window.waitForURL(/desktop\.html/, { timeout: 90_000 });
    result.dir = await app.evaluate(({ app: electronApp }) => electronApp.getPath('crashDumps'));
    result.upload = settings?.crashReports === 'off' ? null : await app.evaluate(({ crashReporter }) => crashReporter.getUploadToServer());
    const child = app.process();
    const exited = new Promise((resolve) => child.once('exit', resolve));
    await app.evaluate(() => { setTimeout(() => process.crash(), 100); }).catch(() => undefined);
    await exited;
    await sleep(3000); // the crash handler finishes writing
    result.found = dumps(result.dir);
  } catch (error) {
    result.error = error;
  }
  return result;
}

async function finish({ app, home, profile }) {
  try {
    await teardown({ app, helpers: [path.join(home, '.dolphin-server')], cleanup: [() => killLeftovers(profile)], remove: [home] });
  } finally {
    killLeftovers(profile);
  }
}

test('a crash leaves a report on this computer by default', { timeout: 150_000 }, async () => {
  const r = await crash(null);
  try {
    if (r.error) throw r.error;
    assert.equal(r.dir, path.join(r.profile, 'Crash Reports'));
    assert.equal(r.upload, false);
    assert.ok(r.found.length >= 1, `no .dmp under ${r.dir}`);
  } finally {
    await finish(r);
  }
  assert.deepEqual(leftovers(r.profile), []);
});

test('with crash reports off, a crash leaves none', { timeout: 150_000 }, async () => {
  const r = await crash({ crashReports: 'off' });
  try {
    if (r.error) throw r.error;
    assert.deepEqual(r.found, []);
  } finally {
    await finish(r);
  }
  assert.deepEqual(leftovers(r.profile), []);
});

test('Help → Show Crash Reports opens that folder', { timeout: 120_000 }, async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'dcrash-'));
  const profile = path.join(home, 'profile');
  const app = await launchApp(home, scratchEnv(home));
  try {
    const window = await app.firstWindow();
    await window.waitForURL(/desktop\.html/, { timeout: 90_000 });
    await app.evaluate(({ shell }) => { globalThis.shown = []; shell.openPath = async (target) => { globalThis.shown.push(target); return ''; }; });
    await app.evaluate(({ Menu }) => {
      const find = (items) => items.flatMap((item) => [item, ...(item.submenu ? find(item.submenu.items) : [])]);
      find(Menu.getApplicationMenu().items).find((item) => item.label === 'Show Crash Reports').click();
    });
    await window.waitForTimeout(500);
    assert.deepEqual(await app.evaluate(() => globalThis.shown), [path.join(profile, 'Crash Reports')]);
  } finally {
    await finish({ app, home, profile });
  }
});
