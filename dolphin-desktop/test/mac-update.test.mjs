// A packaged Mac app without a Developer ID updates itself in place, end to
// end: a newer build served from a local release feed downloads, is checked
// and unpacked, and replaces the installed app when Dolphin quits. Runs on a
// Mac when DOLPHIN_DESKTOP_APP is the packaged executable (CI's macOS first
// run); mac-inplace.test.mjs covers the parts that run anywhere, opening the
// new app after Restart to Update included.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import { quitApp, teardown } from './support.mjs';

const executable = process.env.DOLPHIN_DESKTOP_APP;
const bundle = executable && /^(.+\.app)\/Contents\/MacOS\/[^/]+$/.exec(executable)?.[1];
// codesign -dv reports on stderr.
const adhoc = Boolean(bundle) && process.platform === 'darwin'
  && /Signature=adhoc/.test(spawnSync('/usr/bin/codesign', ['-dv', bundle], { encoding: 'utf8' }).stderr ?? '');
const skip = process.platform !== 'darwin' ? 'macOS only'
  : !bundle ? 'DOLPHIN_DESKTOP_APP is not a packaged Mac app'
  : !adhoc ? 'a Developer ID build updates through electron-updater'
  : false;

const plistVersion = (app) => execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', path.join(app, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('an unsigned Mac app downloads, checks and installs its update in place', { timeout: 600_000, skip }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dmacup-'));
  const home = path.join(dir, 'home');
  const installed = path.join(dir, 'Applications', 'Dolphin.app');
  const files = path.join(dir, 'files');
  for (const folder of [home, path.dirname(installed), files, path.join(dir, 'next')]) mkdirSync(folder, { recursive: true });
  // The installed app, and a newer one: the same build as 9.9.9, signed again.
  execFileSync('/usr/bin/ditto', [bundle, installed]);
  const next = path.join(dir, 'next', 'Dolphin.app');
  execFileSync('/usr/bin/ditto', [bundle, next]);
  execFileSync('/usr/bin/plutil', ['-replace', 'CFBundleShortVersionString', '-string', '9.9.9', path.join(next, 'Contents', 'Info.plist')]);
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', '--preserve-metadata=entitlements', next]);
  const arch = execFileSync('/usr/bin/lipo', ['-archs', path.join(installed, 'Contents', 'MacOS', 'Dolphin')], { encoding: 'utf8' }).includes('arm64') ? 'arm64' : 'x64';
  const zipName = `Dolphin-9.9.9-mac-${arch}.zip`;
  const zip = path.join(files, zipName);
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', next, zip]);
  const sha512 = await new Promise((resolve, reject) => {
    const hash = createHash('sha512');
    createReadStream(zip).on('data', (chunk) => hash.update(chunk)).on('end', () => resolve(hash.digest('base64'))).on('error', reject);
  });
  writeFileSync(path.join(files, 'latest-mac.yml'), `version: 9.9.9\nfiles:\n  - url: ${zipName}\n    sha512: ${sha512}\n    size: ${statSync(zip).size}\npath: ${zipName}\nsha512: ${sha512}\n`);

  const server = createServer((request, response) => {
    if (request.url === '/releases') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify([{ tag_name: 'desktop-v9.9.9', html_url: 'https://example.invalid/9.9.9', draft: false, prerelease: false, assets: [] }]));
      return;
    }
    const file = path.join(files, path.basename(request.url ?? ''));
    if (!request.url?.startsWith('/files/') || !existsSync(file)) { response.statusCode = 404; response.end(); return; }
    response.setHeader('Content-Length', String(statSync(file).size));
    createReadStream(file).pipe(response);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('DOLPHIN_') && key !== 'TMUX' && key !== 'TMUX_PANE'));
  const env = { ...clean, HOME: home, TMUX_TMPDIR: path.join(home, 'tmux'), ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    DOLPHIN_DESKTOP_UPDATE_FEED: `${base}/releases`, DOLPHIN_DESKTOP_UPDATE_FILES: `${base}/files`, DOLPHIN_DESKTOP_UPDATE_DELAY_MS: '500' };
  mkdirSync(env.TMUX_TMPDIR, { recursive: true });
  const helper = path.join(installed, 'Contents', 'Resources', 'helper', `darwin-${arch}`, 'dolphin-helper', 'dolphin-helper');
  let app;
  try {
    app = await electron.launch({ executablePath: path.join(installed, 'Contents', 'MacOS', 'Dolphin'), args: [`--user-data-dir=${path.join(home, 'profile')}`], env });
    const window = await app.firstWindow();
    await window.waitForURL(/app:\/\/dolphin\/desktop\.html/, { timeout: 120_000 });
    // Downloading, then Restart to Update: no browser, no installer.
    let state;
    for (let i = 0; i < 480; i += 1) {
      state = await window.evaluate(() => window.dolphinDesktop.update());
      if (state.state === 'ready' || state.state === 'error' || state.state === 'available') break;
      await sleep(500);
    }
    assert.equal(state.state, 'ready', `the update reached ${JSON.stringify(state)}`);
    assert.equal(state.version, '9.9.9');
    assert.equal(plistVersion(installed), JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(bundle, 'Contents', 'Info.plist')], { encoding: 'utf8' })).CFBundleShortVersionString, 'nothing changes before Dolphin quits');

    // Quitting installs it.
    await quitApp(app);
    app = undefined;
    for (let i = 0; i < 100 && plistVersion(installed) !== '9.9.9'; i += 1) await sleep(200);
    assert.equal(plistVersion(installed), '9.9.9');
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', installed]);
    assert.deepEqual(readdirSync(path.dirname(installed)), ['Dolphin.app'], 'no old copy is left beside it');
  } finally {
    server.close();
    await teardown({ app, helpers: [[path.join(home, '.dolphin-server'), { command: [helper], cwd: undefined, env }]], remove: [dir] });
  }
});
