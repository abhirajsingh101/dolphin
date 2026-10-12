// Connect to Machine over SSH, end to end, against this machine's own sshd:
// uploads the real helper bundle into a scratch remote home, starts it, and
// adds the machine to the same window as its own section of the projects list,
// through the SSH forward. Skips when `ssh localhost` is not available with keys.
// The remote helper uses the real tmux server, so nothing here starts a session.
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

/** Connect to a Machine… under the projects → type an address → Enter. */
async function connectFromSidebar(window, target) {
  await window.getByRole('button', { name: 'Connect to a Machine…' }).click();
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

const windowCount = (app) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
const machineState = (window, id) => window.evaluate((id) => window.dolphinDesktop.machineList().find((m) => m.id === id)?.state ?? null, id);
const section = (window, label) => window.getByRole('region', { name: `${label} projects` });
const connected = (window, label) => section(window, label).getByRole('button', { name: new RegExp(`^${label}, Connected`) });

test('a machine joins the window as its own section, stays connected, and comes back at the next launch', { timeout: 300_000, skip: !canSsh || !existsSync(bundle) }, async () => {
  const localHome = mkdtempSync(path.join(tmpdir(), 'dl-'));
  const remoteHome = mkdtempSync('/tmp/dr-');
  rmSync(remoteHome, { recursive: true }); // the app must create it
  const launch = () => electron.launch({
    args: ['--no-sandbox', `--user-data-dir=${path.join(localHome, 'profile')}`, root],
    env: { ...process.env, DOLPHIN_HOME: localHome, DOLPHIN_DESKTOP_REMOTE_HOME: remoteHome, DOLPHIN_GBRAIN: 'off', DOLPHIN_TMUX_IMPORT: 'off', DOLPHIN_DESKTOP_REMOTE_ENV: 'DOLPHIN_GBRAIN=off DOLPHIN_TMUX_IMPORT=off', ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
  });
  let app = await launch();
  try {
    const window = await app.firstWindow();
    await window.waitForURL(/desktop\.html/, { timeout: 90_000 });
    await section(window, 'This Computer').waitFor();
    await connectFromSidebar(window, 'localhost');
    // The machine joins this window, below This Computer, and connects there.
    await section(window, 'localhost').waitFor({ timeout: 15_000 });
    await connected(window, 'localhost').waitFor({ timeout: 150_000 });
    assert.equal(await windowCount(app), 1, 'one window for every machine');
    assert.ok(existsSync(path.join(remoteHome, 'versions', version, 'dolphin-helper', 'dolphin-helper')), 'helper installed on the remote');
    assert.ok(existsSync(path.join(remoteHome, 'run', 'server.json')), 'remote helper running');
    await window.screenshot({ path: path.join(shots, 'desktop-ssh.png') });
    const recent = JSON.parse(readFileSync(path.join(localHome, 'profile', 'machines.json'), 'utf8')).recent.map((item) => item.target);
    assert.deepEqual(recent, ['localhost']);

    // The link drops (the shared SSH connection ends, as on a network change):
    // the section says so, comes back by itself, and its address still works.
    await window.evaluate(() => { window.__states = []; window.dolphinDesktop.onMachineList((list) => window.__states.push(list.find((m) => m.id === 'localhost')?.state)); });
    execFileSync('ssh', ['-o', `ControlPath=${path.join(homedir(), '.dolphin-desktop', 'ssh', '%C')}`, '-O', 'exit', 'localhost'], { stdio: 'ignore' });
    await window.waitForFunction(() => window.__states.includes('reconnecting') && window.__states.at(-1) === 'connected', null, { timeout: 90_000 });
    await connected(window, 'localhost').waitFor();
    const apiBase = await window.evaluate(() => window.dolphinDesktop.machineList().find((m) => m.id === 'localhost').apiBase);
    assert.equal((await fetch(`${apiBase}/health`)).ok, true);
    assert.equal(await window.getByText('Failed to fetch').count(), 0);

    // Projects are added from the remote machine's own folders, in its
    // section: its recent repositories, and Add a Project, which browses it.
    const remote = section(window, 'localhost');
    const start = remote.getByRole('region', { name: 'Get started on localhost' });
    await start.waitFor({ timeout: 30_000 });
    assert.equal(await start.getByRole('button', { name: 'Work on Another Machine' }).count(), 0);
    const repo = start.getByRole('listitem').first().getByRole('button');
    if (await repo.count()) {
      const name = (await repo.locator('strong').innerText()).trim();
      await repo.click();
      await remote.locator('summary', { hasText: name }).waitFor({ timeout: 15_000 });
    }
    await remote.getByRole('button', { name: 'Add a project on localhost' }).click();
    await window.getByRole('dialog', { name: /Link a project/i }).getByText('Folders on localhost').waitFor();
    await window.keyboard.press('Escape');

    // Its menu reconnects, sets up a key, or disconnects.
    await remote.getByRole('button', { name: 'localhost options' }).click();
    await window.getByRole('menuitem', { name: 'Disconnect' }).waitFor();
    await window.screenshot({ path: path.join(shots, 'desktop-machine-menu.png') });
    await window.keyboard.press('Escape');

    // Quit with the machine open: the next launch brings it back, in the same window.
    await quit(app);
    app = await launch();
    const again = await app.firstWindow();
    await again.waitForURL(/desktop\.html/, { timeout: 90_000 });
    await connected(again, 'localhost').waitFor({ timeout: 150_000 });
    assert.equal(await windowCount(app), 1);

    // Disconnect: the section goes, and stays gone at the next launch.
    await section(again, 'localhost').getByRole('button', { name: 'localhost options' }).click();
    await again.getByRole('menuitem', { name: 'Disconnect' }).click();
    await section(again, 'localhost').waitFor({ state: 'detached', timeout: 15_000 });
    assert.equal(await machineState(again, 'localhost'), null);
    const saved = JSON.parse(readFileSync(path.join(localHome, 'profile', 'session.json'), 'utf8'));
    assert.deepEqual(saved.machines, []);
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
      ...process.env, DOLPHIN_HOME: localHome, DOLPHIN_DESKTOP_REMOTE_HOME: remoteHome, DOLPHIN_GBRAIN: 'off', DOLPHIN_TMUX_IMPORT: 'off', DOLPHIN_DESKTOP_REMOTE_ENV: 'DOLPHIN_GBRAIN=off DOLPHIN_TMUX_IMPORT=off',
      DOLPHIN_DESKTOP_SSH_OPTIONS: `-o UserKnownHostsFile=${knownHosts} -o StrictHostKeyChecking=ask -o ControlPath=none`,
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    },
  });
  try {
    const window = await app.firstWindow();
    await window.waitForURL(/desktop\.html/, { timeout: 90_000 });
    const asked = app.waitForEvent('window', { predicate: (w) => w.url().includes('askpass.html'), timeout: 60_000 });
    await connectFromSidebar(window, 'localhost');
    const dialog = await asked;
    // ssh's question, said plainly: which machine, and its key on its own line.
    await dialog.getByText(/First connection to localhost/).waitFor();
    assert.match(await dialog.locator('.fingerprint').innerText(), /SHA256:\S+$/);
    await dialog.screenshot({ path: path.join(shots, 'desktop-askpass.png') });
    await dialog.getByRole('button', { name: 'Trust and Connect' }).click();
    await connected(window, 'localhost').waitFor({ timeout: 150_000 });
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
