// Help → Report an Issue… against the real app: a pre-filled issue, and
// nothing personal in it. shell.openExternal is replaced, so no browser opens.
// HOME is a scratch directory, so "private-project" lives under a home that is
// not the user's; the scrub must still remove it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs';
import os, { tmpdir } from 'node:os';
import path from 'node:path';
import { launchApp, scratchEnv, teardown } from './support.mjs';

const root = path.resolve(import.meta.dirname, '..');
const appVersion = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;

test('Report an Issue opens a pre-filled issue with nothing personal in it', { timeout: 120_000 }, async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'dissue-'));
  const dolphinHome = path.join(home, '.dolphin-server');
  const env = scratchEnv(home, { DOLPHIN_TMUX_IMPORT: 'off' });
  let app;
  try {
    app = await launchApp(home, env);
    const window = await app.firstWindow();
    await window.waitForURL(/desktop\.html/, { timeout: 90_000 });
    const user = os.userInfo().username;
    appendFileSync(path.join(dolphinHome, 'logs', 'helper.log'), `opened ${home}/private-project on ${os.hostname()} as ${user}\n`);
    await app.evaluate(({ shell }) => { globalThis.opened = []; shell.openExternal = async (url) => { globalThis.opened.push(url); }; });
    await app.evaluate(({ Menu }) => {
      const find = (items) => items.flatMap((item) => [item, ...(item.submenu ? find(item.submenu.items) : [])]);
      find(Menu.getApplicationMenu().items).find((item) => item.label === 'Report an Issue…').click();
    });
    let opened = [];
    for (let i = 0; i < 40 && opened.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      opened = await app.evaluate(() => globalThis.opened);
    }
    assert.equal(opened.length, 1);
    const url = new URL(opened[0]);
    assert.equal(`${url.origin}${url.pathname}`, 'https://github.com/abhirajsingh101/dolphin/issues/new');
    const filled = [...url.searchParams.values()].join('\n');
    assert.match(filled, new RegExp(`Dolphin ${appVersion.replaceAll('.', '\\.')} \\(stable channel\\)`));
    assert.match(filled, /Helper \d+\.\d+\.\d+/);
    assert.match(filled, /opened ~\/private-project on <host> as <user>/);
    const token = readFileSync(path.join(dolphinHome, 'token'), 'utf8').trim();
    for (const secret of [home, os.hostname(), token]) assert.ok(!filled.includes(secret), `the issue carries ${secret}`);
    assert.doesNotMatch(filled, new RegExp(`\\b${user}\\b`));
  } finally {
    await teardown({ app, helpers: [dolphinHome], remove: [home] });
  }
});
