// A file path clicked in a terminal: on this computer it is shown in its
// folder; anything downloaded lands in Downloads under a free name, with no
// dialog. The SSH half (a machine's file saved here) is in ssh.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { downloadPath, safeFileName } from '../dist/downloads.js';
import { launchApp, scratchEnv, teardown } from './support.mjs';

test('a downloaded name keeps to one file in the folder and never leaves it', () => {
  assert.equal(safeFileName('notes.md'), 'notes.md');
  assert.equal(safeFileName('../../etc/passwd'), '.._.._etc_passwd');
  assert.equal(safeFileName('a<b>:c?.txt'), 'a_b__c_.txt');
  assert.equal(safeFileName('trailing. '), 'trailing');
  assert.equal(safeFileName(''), 'download');
  assert.equal(safeFileName('..'), 'download');
});

test('a taken name gets (1), (2)… before its extension', () => {
  const taken = new Set(['/d/report.pdf', '/d/report (1).pdf', '/d/.bashrc', '/d/Makefile']);
  const has = (file) => taken.has(file);
  assert.equal(downloadPath('/d', 'new.txt', has), '/d/new.txt');
  assert.equal(downloadPath('/d', 'report.pdf', has), '/d/report (2).pdf');
  assert.equal(downloadPath('/d', '.bashrc', has), '/d/.bashrc (1)');
  assert.equal(downloadPath('/d', 'Makefile', has), '/d/Makefile (1)');
  assert.equal(downloadPath('/d', 'archive.tar.gz', () => false), '/d/archive.tar.gz');
});

test('on this computer a path is shown in its folder, and downloads go straight to Downloads', { timeout: 120_000 }, async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'dfl-'));
  const env = scratchEnv(home, { DOLPHIN_TMUX_IMPORT: 'off' });
  const file = path.join(home, 'notes.md');
  writeFileSync(file, 'hello\n');
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Disposition': 'attachment; filename="report.txt"', 'Content-Type': 'application/octet-stream' });
    response.end('report body\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let app;
  try {
    app = await launchApp(home, env);
    const window = await app.firstWindow();
    await window.waitForURL(/desktop\.html/, { timeout: 90_000 });
    await app.evaluate(({ shell }) => { globalThis.__shown = []; shell.showItemInFolder = (item) => { globalThis.__shown.push(item); }; });

    assert.deepEqual(await window.evaluate((item) => window.dolphinDesktop.openFile('local', item), file), { shown: file });
    assert.deepEqual(await app.evaluate(() => globalThis.__shown), [file]);
    const missing = await window.evaluate((item) => window.dolphinDesktop.openFile('local', item), path.join(home, 'gone.md'));
    assert.equal(missing.error, 'gone.md is not on this computer.');
    assert.ok((await window.evaluate(() => window.dolphinDesktop.openFile('local', 'notes.md'))).error, 'a relative path is refused');
    assert.ok((await window.evaluate(() => window.dolphinDesktop.openFile('nowhere', '/etc/hosts'))).error, 'a machine not in this window is refused');
    assert.equal((await app.evaluate(() => globalThis.__shown)).length, 1);

    // Any download from the page: no dialog, a free name in Downloads.
    const downloads = await app.evaluate(({ app: electronApp }) => electronApp.getPath('downloads'));
    const url = `http://127.0.0.1:${server.address().port}/report`;
    const saved = await app.evaluate(({ BrowserWindow, session }, target) => new Promise((resolve) => {
      const files = [];
      const done = (_event, item) => item.once('done', () => { files.push(item.getSavePath()); if (files.length === 2) { session.defaultSession.off('will-download', done); resolve(files.sort()); } });
      session.defaultSession.on('will-download', done);
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      contents.downloadURL(target);
      contents.downloadURL(target);
    }), url);
    assert.deepEqual(saved, [path.join(downloads, 'report (1).txt'), path.join(downloads, 'report.txt')]);
    for (const item of saved) assert.equal(readFileSync(item, 'utf8'), 'report body\n');
  } finally {
    server.close();
    await teardown({ app, helpers: [[env.DOLPHIN_HOME, { env }]], remove: [home] });
  }
});
