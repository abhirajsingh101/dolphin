// App-level keys are menu items (spec: "Keyboard"), so they work while a
// terminal has focus; each sends one command id to the page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { commandItem, COMMAND_IDS, keyBindings, newWindowAccelerator } from '../dist/keymap.js';
import { launchApp, scratchEnv, teardown } from './support.mjs';

const SESSIONS = Array.from({ length: 9 }, (_, i) => `session-${i + 1}`);
const SPEC_IDS = ['palette', ...SESSIONS, 'new-session', 'prev-tab', 'next-tab', 'settings', 'find', 'zoom-in', 'zoom-out', 'zoom-reset', 'close-view'];

test('the command ids are exactly the spec list', () => {
  assert.deepEqual([...COMMAND_IDS], SPEC_IDS);
});

test('macOS follows the spec table', () => {
  const keys = Object.fromEntries(keyBindings('darwin').map((binding) => [binding.id, binding.accelerator]));
  assert.deepEqual(keys, {
    palette: 'CmdOrCtrl+Shift+K',
    ...Object.fromEntries(SESSIONS.map((id, i) => [id, `CmdOrCtrl+${i + 1}`])),
    'new-session': 'CmdOrCtrl+Shift+T', 'prev-tab': 'CmdOrCtrl+Shift+[', 'next-tab': 'CmdOrCtrl+Shift+]',
    settings: 'CmdOrCtrl+,', find: 'Cmd+F', 'zoom-in': 'CmdOrCtrl+=', 'zoom-out': 'CmdOrCtrl+-', 'zoom-reset': 'CmdOrCtrl+0',
    'close-view': 'Cmd+W',
  });
});

test('Linux and Windows leave the shell’s Ctrl keys to the terminal', () => {
  for (const platform of ['linux', 'win32']) {
    const bindings = keyBindings(platform);
    assert.equal(bindings.find((binding) => binding.id === 'find').accelerator, 'Ctrl+Shift+F');
    assert.equal(bindings.some((binding) => binding.id === 'close-view'), false);
    const stolen = bindings.filter((binding) => /^(CmdOrCtrl|Ctrl)\+[A-Z]$/i.test(binding.accelerator));
    assert.deepEqual(stolen, [], `plain Ctrl+letter belongs to the program in the terminal: ${JSON.stringify(stolen)}`);
  }
});

test('every accelerator is used once', () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    const accelerators = keyBindings(platform).map((binding) => binding.accelerator);
    assert.equal(new Set(accelerators).size, accelerators.length, platform);
  }
});

test('New Window is Cmd+N on macOS and Ctrl+Shift+N elsewhere, and no command shares it', () => {
  assert.equal(newWindowAccelerator('darwin'), 'Cmd+N');
  for (const platform of ['linux', 'win32']) assert.equal(newWindowAccelerator(platform), 'Ctrl+Shift+N');
  for (const platform of ['darwin', 'linux', 'win32']) {
    const taken = [...keyBindings(platform).map((binding) => binding.accelerator), 'CmdOrCtrl+Shift+O'];
    assert.equal(taken.includes(newWindowAccelerator(platform)), false, platform);
  }
});

test('a menu item carries its id and sends it', () => {
  const sent = [];
  const item = commandItem(keyBindings('linux'), 'palette', (id) => sent.push(id));
  assert.equal(item.id, 'palette');
  assert.equal(item.accelerator, 'CmdOrCtrl+Shift+K');
  item.click();
  assert.deepEqual(sent, ['palette']);
  assert.throws(() => commandItem(keyBindings('linux'), 'close-view', () => undefined), /No key binding for close-view/);
});

test('the real menu sends its command to the page', { timeout: 120_000 }, async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'dkey-'));
  let app;
  try {
    app = await launchApp(home, scratchEnv(home, { DOLPHIN_TMUX_IMPORT: 'off' }));
    const window = await app.firstWindow();
    await window.waitForURL(/app:\/\/dolphin\/desktop\.html/, { timeout: 90_000 });
    const items = await app.evaluate(({ Menu }, ids) => ids.map((id) => [id, Menu.getApplicationMenu().getMenuItemById(id)?.accelerator ?? null]), SPEC_IDS);
    for (const [id, accelerator] of items) {
      if (id === 'close-view' && process.platform !== 'darwin') assert.equal(accelerator, null);
      else assert.ok(accelerator, `${id} has a menu item with an accelerator`);
    }
    const reload = await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('reload')?.accelerator ?? null);
    if (process.platform !== 'darwin') assert.equal(reload, null, 'Ctrl+R is reverse-i-search in a terminal');
    // Wait for the workspace without clicking, then click exactly once.
    await window.waitForSelector('.glass-workspace', { timeout: 60_000 });
    await window.evaluate(() => { window.__heard = []; window.dolphinDesktop.onCommand((id) => window.__heard.push(id)); });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('next-tab').click());
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.deepEqual(await window.evaluate(() => window.__heard), ['next-tab']);
    if (process.platform !== 'darwin') {
      const bound = await app.evaluate(({ Menu }) => {
        const out = [];
        const walk = (menu) => { for (const item of menu.items) { out.push([item.label, item.role ?? '', item.accelerator ?? '']); if (item.submenu) walk(item.submenu); } };
        walk(Menu.getApplicationMenu());
        return out;
      });
      const clash = bound.filter(([, role, accelerator]) => /^(CommandOrControl|CmdOrCtrl|Ctrl|Control)\+[WFR]$/i.test(accelerator) || (role === 'close' && !accelerator));
      assert.deepEqual(clash, [], 'no Ctrl+W/F/R accelerator off macOS (the terminal needs them)');
    }
  } finally {
    await teardown({ app, helpers: [path.join(home, '.dolphin-server')], remove: [home] });
  }
});
