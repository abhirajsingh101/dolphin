// Connect to Machine over SSH, end to end, against this machine's own sshd:
// uploads the real helper bundle into a scratch remote home, starts it, opens
// a workspace window through the SSH forward. Skips when `ssh localhost`
// is not available with keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { _electron as electron } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const shots = process.env.DOLPHIN_SHOTS || tmpdir();
const bundle = path.join(root, 'helper-bundles', `${process.platform}-${process.arch === 'arm64' ? 'arm64' : 'x64'}.tar.xz`);
let canSsh = true;
try {
  execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', 'localhost', 'true'], { stdio: 'ignore' });
} catch {
  canSsh = false;
}

test('Connect to Machine sets Dolphin up over SSH and opens its workspace', { timeout: 180_000, skip: !canSsh || !existsSync(bundle) }, async () => {
  const localHome = mkdtempSync(path.join(tmpdir(), 'dl-'));
  const remoteHome = mkdtempSync('/tmp/dr-');
  rmSync(remoteHome, { recursive: true }); // the app must create it
  const app = await electron.launch({
    args: ['--no-sandbox', root],
    env: { ...process.env, DOLPHIN_HOME: localHome, DOLPHIN_DESKTOP_REMOTE_HOME: remoteHome, DOLPHIN_GBRAIN: 'off', DOLPHIN_DESKTOP_REMOTE_ENV: 'DOLPHIN_GBRAIN=off', ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
  });
  try {
    const local = await app.firstWindow();
    await local.waitForURL(/desktop\.html/, { timeout: 90_000 });
    await app.evaluate(({ Menu }) => {
      const file = Menu.getApplicationMenu().items.find((item) => item.label === 'File');
      file.submenu.items.find((item) => item.label.startsWith('Connect to Machine')).click();
    });
    const connect = await app.waitForEvent('window', { predicate: (w) => w.url().includes('connect.html') });
    await connect.getByRole('textbox', { name: 'SSH host' }).fill('localhost');
    const remoteWindow = app.waitForEvent('window', { predicate: (w) => !w.url().includes('connect.html'), timeout: 60_000 });
    await connect.getByRole('button', { name: 'Connect' }).click();
    const remote = await remoteWindow;
    await remote.waitForURL(/desktop\.html/, { timeout: 150_000 });
    await remote.getByText(/sessions in view/).waitFor({ timeout: 30_000 });
    const titles = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.getTitle()));
    assert.ok(titles.includes('Dolphin — localhost'), `window titles: ${titles}`);
    assert.ok(existsSync(path.join(remoteHome, 'versions', version, 'dolphin-helper', 'dolphin-helper')), 'helper installed on the remote');
    assert.ok(existsSync(path.join(remoteHome, 'run', 'server.json')), 'remote helper running');
    await remote.screenshot({ path: path.join(shots, 'desktop-ssh.png') });
  } finally {
    const exited = new Promise((resolve) => app.process().once('exit', resolve));
    await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined);
    await exited;
    const helper = path.join(remoteHome, 'versions', version, 'dolphin-helper', 'dolphin-helper');
    for (const [binary, home] of [[helper, remoteHome], [path.join(root, 'helper-bundles', `${process.platform}-x64`, 'dolphin-helper', 'dolphin-helper'), localHome]]) {
      try { execFileSync(binary, ['stop'], { env: { ...process.env, DOLPHIN_HOME: home } }); } catch { /* not running */ }
    }
    try { execFileSync(path.resolve(root, '..', 'dolphin-backend', 'venv', 'bin', 'python'), ['-m', 'app.helper', 'stop'], { cwd: path.resolve(root, '..', 'dolphin-backend'), env: { ...process.env, DOLPHIN_HOME: localHome } }); } catch { /* not running */ }
    rmSync(localHome, { recursive: true, force: true });
    rmSync(remoteHome, { recursive: true, force: true });
  }
});

test('the first connection asks to trust the host key inside the app', { timeout: 180_000, skip: !canSsh || !existsSync(bundle) }, async () => {
  const localHome = mkdtempSync(path.join(tmpdir(), 'dl-'));
  const remoteHome = mkdtempSync('/tmp/dr-');
  const knownHosts = path.join(mkdtempSync(path.join(tmpdir(), 'kh-')), 'known_hosts');
  rmSync(remoteHome, { recursive: true });
  const app = await electron.launch({
    args: ['--no-sandbox', root],
    env: {
      ...process.env, DOLPHIN_HOME: localHome, DOLPHIN_DESKTOP_REMOTE_HOME: remoteHome, DOLPHIN_GBRAIN: 'off', DOLPHIN_DESKTOP_REMOTE_ENV: 'DOLPHIN_GBRAIN=off',
      DOLPHIN_DESKTOP_SSH_OPTIONS: `-o UserKnownHostsFile=${knownHosts} -o StrictHostKeyChecking=ask -o ControlPath=none`,
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    },
  });
  try {
    await (await app.firstWindow()).waitForURL(/desktop\.html/, { timeout: 90_000 });
    await app.evaluate(({ Menu }) => {
      const file = Menu.getApplicationMenu().items.find((item) => item.label === 'File');
      file.submenu.items.find((item) => item.label.startsWith('Connect to Machine')).click();
    });
    const connect = await app.waitForEvent('window', { predicate: (w) => w.url().includes('connect.html') });
    await connect.getByRole('textbox', { name: 'SSH host' }).fill('localhost');
    const asked = app.waitForEvent('window', { predicate: (w) => w.url().includes('askpass.html'), timeout: 60_000 });
    await connect.getByRole('button', { name: 'Connect' }).click();
    const dialog = await asked;
    await dialog.getByText(/authenticity of host|fingerprint/i).waitFor();
    await dialog.screenshot({ path: path.join(shots, 'desktop-askpass.png') });
    await dialog.getByRole('button', { name: 'Trust and Connect' }).click();
    await app.waitForEvent('window', { predicate: (w) => w.url().includes('desktop.html'), timeout: 150_000 }).catch(() => undefined);
    await expectWindowTitle(app, 'Dolphin — localhost');
    assert.ok(existsSync(knownHosts), 'the trusted key was recorded in the scratch known_hosts');
  } finally {
    const exited = new Promise((resolve) => app.process().once('exit', resolve));
    await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined);
    await exited;
    const helper = path.join(remoteHome, 'versions', version, 'dolphin-helper', 'dolphin-helper');
    try { execFileSync(helper, ['stop'], { env: { ...process.env, DOLPHIN_HOME: remoteHome } }); } catch { /* not running */ }
    try { execFileSync(path.resolve(root, '..', 'dolphin-backend', 'venv', 'bin', 'python'), ['-m', 'app.helper', 'stop'], { cwd: path.resolve(root, '..', 'dolphin-backend'), env: { ...process.env, DOLPHIN_HOME: localHome } }); } catch { /* not running */ }
    rmSync(localHome, { recursive: true, force: true });
    rmSync(remoteHome, { recursive: true, force: true });
  }
});

async function expectWindowTitle(app, title) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const titles = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.getTitle()));
    if (titles.includes(title)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.fail(`no window titled ${title}`);
}
