// A file path clicked in a terminal: on this computer it is shown in its
// folder; anything downloaded lands in Downloads under a free name, with no
// dialog. The SSH half (a machine's file saved here) is in ssh.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { downloadFailure, downloadPath, keepRecent, safeFileName } from '../dist/downloads.js';
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

test('the list keeps the newest 20 and never drops one still downloading', () => {
  const entry = (n, state = 'completed') => ({ id: `d${n}`, name: `${n}`, file: `/d/${n}`, received: 0, total: 0, state, started: n });
  const list = [entry(1, 'progressing'), ...Array.from({ length: 25 }, (_, i) => entry(i + 2))];
  const kept = keepRecent(list);
  assert.equal(kept.length, 20);
  assert.equal(kept[0].id, 'd26', 'newest first');
  assert.ok(kept.some((item) => item.id === 'd1'), 'the oldest is kept while it downloads');
  assert.equal(downloadFailure('cancelled', 'gpu-box'), 'Cancelled');
  assert.match(downloadFailure('interrupted', 'gpu-box'), /check that gpu-box is still connected/);
});

test('on this computer a path is shown in its folder, and downloads go straight to Downloads', { timeout: 120_000 }, async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'dfl-'));
  const env = scratchEnv(home, { DOLPHIN_TMUX_IMPORT: 'off' });
  const file = path.join(home, 'notes.md');
  writeFileSync(file, 'hello\n');
  const server = http.createServer((request, response) => {
    if (request.url.endsWith('/slow')) {
      // Half the bytes, then nothing until the download is cancelled.
      response.writeHead(200, { 'Content-Disposition': 'attachment; filename="big.bin"', 'Content-Type': 'application/octet-stream', 'Content-Length': '1000000' });
      response.write(Buffer.alloc(500_000));
      return;
    }
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

    // Every window has the list: both finished, newest first, with their sizes.
    await window.waitForFunction(() => window.dolphinDesktop.downloads().filter((item) => item.state === 'completed').length === 2);
    const listed = await window.evaluate(() => window.dolphinDesktop.downloads());
    assert.deepEqual(listed.map((item) => [item.state, item.received, item.total]), [['completed', 12, 12], ['completed', 12, 12]]);
    assert.deepEqual(listed.map((item) => item.file).sort(), saved);
    assert.deepEqual(await window.evaluate((id) => window.dolphinDesktop.showDownload(id), listed[0].id), { ok: true });
    assert.equal((await app.evaluate(() => globalThis.__shown)).at(-1), listed[0].file);

    // A slow one is in the list while it downloads, with its size, and Cancel stops it.
    await window.evaluate(() => { window.__heard = []; window.dolphinDesktop.onDownloads((list) => window.__heard.push(list)); });
    await app.evaluate(({ BrowserWindow }, target) => { BrowserWindow.getAllWindows()[0].webContents.downloadURL(target); }, `${url}/slow`);
    await window.waitForFunction(() => window.dolphinDesktop.downloads().some((item) => item.state === 'progressing' && item.received > 0));
    const slow = (await window.evaluate(() => window.dolphinDesktop.downloads())).find((item) => item.state === 'progressing');
    assert.equal(slow.total, 1_000_000);
    assert.equal(slow.name, 'big.bin');
    // The real window: the button rings and the list opened by itself.
    await window.getByRole('button', { name: 'Downloads, 1 in progress' }).waitFor({ timeout: 10_000 });
    await window.getByRole('dialog', { name: 'Downloads' }).getByText(/500 KB of 1\.0 MB/).waitFor({ timeout: 10_000 });
    await window.waitForTimeout(400);  // the bar's 160ms fill
    await window.screenshot({ path: path.join(process.env.DOLPHIN_SHOTS || tmpdir(), 'desktop-downloads.png') });
    await window.evaluate((id) => window.dolphinDesktop.cancelDownload(id), slow.id);
    await window.waitForFunction((id) => window.dolphinDesktop.downloads().find((item) => item.id === id)?.state === 'cancelled', slow.id);
    assert.ok(await window.evaluate(() => window.__heard.length > 0), 'the page heard the changes');
    assert.ok((await window.evaluate((id) => window.dolphinDesktop.showDownload(id), slow.id)).error, 'a cancelled one has nothing to show');

    // Clear keeps only what is still downloading: here, nothing.
    await window.evaluate(() => window.dolphinDesktop.clearDownloads());
    await window.waitForFunction(() => window.dolphinDesktop.downloads().length === 0);
  } finally {
    server.closeAllConnections();
    server.close();
    await teardown({ app, helpers: [[env.DOLPHIN_HOME, { env }]], remove: [home] });
  }
});
