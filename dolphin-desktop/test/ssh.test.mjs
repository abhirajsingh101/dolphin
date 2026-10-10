// Connect to Machine over SSH, end to end, against this machine's own sshd:
// uploads the real helper bundle into a scratch remote home, starts it, opens
// a workspace window through the SSH forward. Skips when `ssh localhost`
// is not available with keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
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

/** The machine chip's menu → Connect to a Machine… → type an address → Enter. */
async function connectFromChip(window, target) {
  await window.getByRole('button', { name: /^Machine: / }).click();
  await window.getByRole('menuitem', { name: 'Connect to a Machine…' }).click();
  const dialog = window.getByRole('dialog', { name: 'Connect to a Machine' });
  await dialog.getByRole('combobox', { name: 'Machine name or address' }).fill(target);
  await dialog.getByRole('option', { name: new RegExp(`Connect to ${target}`) }).waitFor();
  await window.screenshot({ path: path.join(shots, 'desktop-connect-dialog.png') });
  await window.keyboard.press('Enter');
}

const quit = async (app) => {
  const exited = new Promise((resolve) => app.process().once('exit', resolve));
  await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined);
  await exited;
};

test('a machine connects from the header, stays connected, and comes back at the next launch', { timeout: 300_000, skip: !canSsh || !existsSync(bundle) }, async () => {
  const localHome = mkdtempSync(path.join(tmpdir(), 'dl-'));
  const remoteHome = mkdtempSync('/tmp/dr-');
  rmSync(remoteHome, { recursive: true }); // the app must create it
  const launch = () => electron.launch({
    args: ['--no-sandbox', `--user-data-dir=${path.join(localHome, 'profile')}`, root],
    env: { ...process.env, DOLPHIN_HOME: localHome, DOLPHIN_DESKTOP_REMOTE_HOME: remoteHome, DOLPHIN_GBRAIN: 'off', DOLPHIN_DESKTOP_REMOTE_ENV: 'DOLPHIN_GBRAIN=off', ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
  });
  let app = await launch();
  try {
    const local = await app.firstWindow();
    await local.waitForURL(/desktop\.html/, { timeout: 90_000 });
    const remoteWindow = app.waitForEvent('window', { predicate: (w) => !w.url().includes('desktop.html'), timeout: 60_000 });
    await connectFromChip(local, 'localhost');
    const remote = await remoteWindow;
    await remote.waitForURL(/desktop\.html/, { timeout: 150_000 });
    await remote.getByText(/sessions in view/).waitFor({ timeout: 30_000 });
    await expectWindowTitle(app, 'Dolphin — localhost');
    assert.ok(existsSync(path.join(remoteHome, 'versions', version, 'dolphin-helper', 'dolphin-helper')), 'helper installed on the remote');
    assert.ok(existsSync(path.join(remoteHome, 'run', 'server.json')), 'remote helper running');
    await remote.getByRole('button', { name: 'Machine: localhost, Connected' }).waitFor();
    await remote.screenshot({ path: path.join(shots, 'desktop-ssh.png') });
    const recent = JSON.parse(readFileSync(path.join(localHome, 'profile', 'machines.json'), 'utf8')).recent.map((item) => item.target);
    assert.deepEqual(recent, ['localhost']);

    // The link drops (the shared SSH connection ends, as on a network change):
    // the window says so, comes back by itself, and its address still works.
    await remote.evaluate(() => { window.__links = []; window.dolphinDesktop.onConnection((link) => window.__links.push(link.state)); });
    execFileSync('ssh', ['-o', `ControlPath=${path.join(homedir(), '.dolphin-desktop', 'ssh', '%C')}`, '-O', 'exit', 'localhost'], { stdio: 'ignore' });
    await remote.waitForFunction(() => window.__links.includes('reconnecting') && window.__links.at(-1) === 'connected', null, { timeout: 90_000 });
    await remote.getByRole('button', { name: 'Machine: localhost, Connected' }).waitFor();
    const apiBase = await remote.evaluate(() => window.dolphinDesktop.config.apiBase);
    assert.equal((await fetch(`${apiBase}/health`)).ok, true);
    // The workspace loads again at once, with no stale error left behind.
    await remote.getByText(/sessions in view/).waitFor({ timeout: 10_000 });
    assert.equal(await remote.getByText('Failed to fetch').count(), 0);

    // Projects are added from the remote machine's own folders: its recent
    // repositories, and Add a Project, which browses that machine.
    const start = remote.getByRole('region', { name: 'Get started' });
    await start.getByRole('button', { name: 'Work on Another Machine' }).waitFor();
    const repo = start.getByRole('listitem').first().getByRole('button');
    if (await repo.count()) {
      const name = (await repo.locator('strong').innerText()).trim();
      await repo.click();
      await remote.locator('.glass-tree summary', { hasText: name }).waitFor({ timeout: 15_000 });
    }
    await remote.getByRole('button', { name: 'Add a project' }).click();
    await remote.getByRole('dialog', { name: /Link a project/i }).waitFor();
    await remote.keyboard.press('Escape');

    // The chip's menu lists this computer, to switch back.
    await remote.getByRole('button', { name: /^Machine: / }).click();
    await remote.getByRole('menuitem', { name: /This Computer/ }).waitFor();
    await remote.screenshot({ path: path.join(shots, 'desktop-machine-menu.png') });
    await remote.keyboard.press('Escape');

    // Quit with both machines open: the next launch opens both again.
    await quit(app);
    app = await launch();
    await expectWindowTitle(app, 'Dolphin — localhost');
    const titles = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.getTitle()));
    assert.equal(titles.length, 2, `window titles: ${titles}`);
  } finally {
    await quit(app);
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
    args: ['--no-sandbox', `--user-data-dir=${path.join(localHome, 'profile')}`, root],
    env: {
      ...process.env, DOLPHIN_HOME: localHome, DOLPHIN_DESKTOP_REMOTE_HOME: remoteHome, DOLPHIN_GBRAIN: 'off', DOLPHIN_DESKTOP_REMOTE_ENV: 'DOLPHIN_GBRAIN=off',
      DOLPHIN_DESKTOP_SSH_OPTIONS: `-o UserKnownHostsFile=${knownHosts} -o StrictHostKeyChecking=ask -o ControlPath=none`,
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    },
  });
  try {
    const local = await app.firstWindow();
    await local.waitForURL(/desktop\.html/, { timeout: 90_000 });
    const asked = app.waitForEvent('window', { predicate: (w) => w.url().includes('askpass.html'), timeout: 60_000 });
    await connectFromChip(local, 'localhost');
    const dialog = await asked;
    // ssh's question, said plainly: which machine, and its key on its own line.
    await dialog.getByText(/First connection to localhost/).waitFor();
    assert.match(await dialog.locator('.fingerprint').innerText(), /SHA256:\S+$/);
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
