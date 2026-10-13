// Connect to Machine over SSH, end to end, against this machine's own sshd:
// uploads the real helper bundle into a scratch remote home, starts it, and
// adds the machine to the same window as its own section of the projects list,
// through the SSH forward. Skips when `ssh localhost` is not available with keys.
// The remote helper uses the real tmux server, so nothing here starts a session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import http from 'node:http';
import { _electron as electron } from 'playwright';
import { SSH_TEST_OPTIONS, launchApp, quitApp, scratchEnv, teardown } from './support.mjs';

const root = path.resolve(import.meta.dirname, '..');
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const shots = process.env.DOLPHIN_SHOTS || tmpdir();
const bundle = path.join(root, 'helper-bundles', `${process.platform}-${process.arch === 'arm64' ? 'arm64' : 'x64'}.tar.xz`);
let canSsh = true;
try {
  execFileSync('ssh', [...SSH_TEST_OPTIONS.split(' '), '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', 'localhost', 'true'], { stdio: 'ignore' });
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

const windowCount = (app) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
const machineState = (window, id) => window.evaluate((id) => window.dolphinDesktop.machineList().find((m) => m.id === id)?.state ?? null, id);
const section = (window, label) => window.getByRole('region', { name: `${label} projects` });
const connected = (window, label) => section(window, label).getByRole('button', { name: new RegExp(`^${label}, Connected`) });

test('a machine joins the window as its own section, stays connected, and comes back at the next launch', { timeout: 300_000, skip: !canSsh || !existsSync(bundle) }, async () => {
  const localHome = mkdtempSync(path.join(tmpdir(), 'dl-'));
  const remoteHome = mkdtempSync('/tmp/dr-');
  rmSync(remoteHome, { recursive: true }); // the app must create it
  const controlDir = mkdtempSync('/tmp/dc-'); // a scratch control socket, not one under the real ~/.dolphin-desktop
  const controlPath = path.join(controlDir, '%C');
  const launch = () => electron.launch({
    args: ['--no-sandbox', `--user-data-dir=${path.join(localHome, 'profile')}`, root],
    env: { ...process.env, DOLPHIN_HOME: localHome, DOLPHIN_DESKTOP_REMOTE_HOME: remoteHome, DOLPHIN_GBRAIN: 'off', DOLPHIN_TMUX_IMPORT: 'off', DOLPHIN_DESKTOP_REMOTE_ENV: 'DOLPHIN_GBRAIN=off DOLPHIN_TMUX_IMPORT=off', DOLPHIN_DESKTOP_TEST_NO_OPEN: '1', DOLPHIN_DESKTOP_SSH_OPTIONS: `${SSH_TEST_OPTIONS} -o ControlPath=${controlPath}`, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
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
    execFileSync('ssh', ['-o', `ControlPath=${controlPath}`, '-O', 'exit', 'localhost'], { stdio: 'ignore' });
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
    // The menu draws above the sticky machine rows (no ghosting through them).
    const onTop = await window.evaluate(() => {
      const menu = document.querySelector('.machine-menu');
      const box = menu.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + 12);
      return Boolean(hit && menu.contains(hit));
    });
    assert.ok(onTop, 'the machine menu is the top layer where it draws');
    await window.screenshot({ path: path.join(shots, 'desktop-machine-menu.png') });
    await window.keyboard.press('Escape');

    // Show Remote Log fetches the remote helper's log into the profile.
    await remote.getByRole('button', { name: 'localhost options' }).click();
    await window.getByRole('menuitem', { name: 'Show Remote Log' }).click();
    const logFile = path.join(localHome, 'profile', 'remote-logs', 'localhost-helper.log');
    for (let i = 0; i < 50 && !existsSync(logFile); i += 1) await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(existsSync(logFile), 'the remote log was saved');

    // Quit with the machine open: the next launch brings it back, in the same window.
    await quitApp(app);
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
    try { execFileSync('ssh', ['-o', `ControlPath=${controlPath}`, '-O', 'exit', 'localhost'], { stdio: 'ignore' }); } catch { /* no master */ }
    await teardown({ app, helpers: [remoteHome, localHome], remove: [localHome, remoteHome, controlDir] });
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
      DOLPHIN_DESKTOP_SSH_OPTIONS: `${SSH_TEST_OPTIONS} -o UserKnownHostsFile=${knownHosts} -o StrictHostKeyChecking=ask -o ControlPath=none`,
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
    await teardown({ app, helpers: [remoteHome, localHome], remove: [localHome, remoteHome] });
  }
});

test('a port on the machine opens on this computer and comes back after a reconnect', { timeout: 300_000, skip: !canSsh || !existsSync(bundle) }, async () => {
  const server = http.createServer((_request, response) => response.end('hello from the machine'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const remotePort = server.address().port;
  const localHome = mkdtempSync(path.join(tmpdir(), 'dl-'));
  const remoteHome = mkdtempSync('/tmp/dr-');
  rmSync(remoteHome, { recursive: true });
  const controlDir = mkdtempSync('/tmp/dc-'); // a scratch control socket, not one under the real ~/.dolphin-desktop
  const controlPath = path.join(controlDir, '%C');
  // Both helpers on scratch tmux servers: this computer's through scratchEnv
  // (scratch HOME and TMUX_TMPDIR, TMUX unset), the machine's through its env.
  const remoteTmux = mkdtempSync('/tmp/dt-');
  const app = await electron.launch({
    args: ['--no-sandbox', `--user-data-dir=${path.join(localHome, 'profile')}`, root],
    env: scratchEnv(localHome, {
      DOLPHIN_HOME: localHome, DOLPHIN_DESKTOP_REMOTE_HOME: remoteHome, DOLPHIN_TMUX_IMPORT: 'off',
      DOLPHIN_DESKTOP_REMOTE_ENV: `DOLPHIN_GBRAIN=off DOLPHIN_TMUX_IMPORT=off TMUX_TMPDIR=${remoteTmux}`,
      DOLPHIN_DESKTOP_SSH_OPTIONS: `${SSH_TEST_OPTIONS} -o ControlPath=${controlPath}`,
    }),
  });
  try {
    const window = await app.firstWindow();
    await window.waitForURL(/desktop\.html/, { timeout: 90_000 });
    await connectFromSidebar(window, 'localhost');
    await connected(window, 'localhost').waitFor({ timeout: 150_000 });
    await app.evaluate(({ shell }) => { globalThis.__opened = []; shell.openExternal = async (url) => { globalThis.__opened.push(url); }; });

    const opened = await window.evaluate((port) => window.dolphinDesktop.openPort('localhost', port), remotePort);
    assert.ok(opened.url, opened.error);
    assert.equal(new URL(opened.url).hostname, 'localhost');
    assert.notEqual(new URL(opened.url).port, String(remotePort), 'a new local port, not the remote one');
    assert.equal(await (await fetch(opened.url)).text(), 'hello from the machine');
    assert.deepEqual(await app.evaluate(() => globalThis.__opened), [opened.url]);

    await window.evaluate(() => { window.__states = []; window.dolphinDesktop.onMachineList((list) => window.__states.push(list.find((m) => m.id === 'localhost')?.state)); });
    execFileSync('ssh', ['-o', `ControlPath=${controlPath}`, '-O', 'exit', 'localhost'], { stdio: 'ignore' });
    await window.waitForFunction(() => window.__states.includes('reconnecting') && window.__states.at(-1) === 'connected', null, { timeout: 90_000 });
    // The link is back first; its forwards follow, on the same port.
    let back = '';
    for (let i = 0; i < 150 && back !== 'hello from the machine'; i += 1) {
      back = await fetch(opened.url).then((response) => response.text(), () => '');
      if (back !== 'hello from the machine') await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.equal(back, 'hello from the machine', 'the forward came back on the same port');

    // A localhost link printed on the machine opens through the same forward.
    const link = await window.evaluate((port) => window.dolphinDesktop.openUrl('localhost', `http://localhost:${port}/docs`), remotePort);
    assert.equal(link.url, new URL('/docs', opened.url).toString());
    // Nothing but a TCP port or a web link is accepted.
    assert.ok((await window.evaluate(() => window.dolphinDesktop.openPort('localhost', 70000))).error);
    assert.ok((await window.evaluate(() => window.dolphinDesktop.openUrl('localhost', 'file:///etc/passwd'))).error);
    // This computer's own relay port never opens in the browser (links.ts).
    const relay = await window.evaluate(() => window.dolphinDesktop.machineList().find((m) => m.id === 'local')?.apiBase);
    assert.ok(relay, 'This Computer has a relay address');
    assert.ok((await window.evaluate((url) => window.dolphinDesktop.openUrl('local', url), relay)).error, 'a Dolphin port is refused');
    assert.equal((await app.evaluate(() => globalThis.__opened)).length, 2);
  } finally {
    server.close();
    try { execFileSync('ssh', ['-o', `ControlPath=${controlPath}`, '-O', 'exit', 'localhost'], { stdio: 'ignore' }); } catch { /* no master */ }
    await teardown({ app, helpers: [remoteHome, localHome], remove: [localHome, remoteHome, controlDir, remoteTmux] });
  }
});

/** Agent keepers left on this machine for these forwarded agent sockets: a
 *  `cat` whose parent is sshd and whose SSH_AUTH_SOCK is one of them. */
function keepersFor(sockets) {
  const found = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      if (readFileSync(`/proc/${entry}/comm`, 'utf8').trim() !== 'cat') continue;
      const ppid = /^PPid:\s+(\d+)/m.exec(readFileSync(`/proc/${entry}/status`, 'utf8'))?.[1];
      if (!ppid || !readFileSync(`/proc/${ppid}/comm`, 'utf8').startsWith('sshd')) continue;
      const agent = readFileSync(`/proc/${entry}/environ`, 'utf8').split('\0').find((pair) => pair.startsWith('SSH_AUTH_SOCK='))?.slice('SSH_AUTH_SOCK='.length);
      if (agent && sockets.has(agent)) found.push(Number(entry));
    } catch (error) {
      if (!['ENOENT', 'ESRCH', 'EACCES'].includes(error.code)) throw error; // gone meanwhile, or not ours
    }
  }
  return found;
}
const until = async (check, tries = 80) => { for (let i = 0; i < tries && !check(); i += 1) await new Promise((resolve) => setTimeout(resolve, 250)); return check(); };

test('agent forwarding points the machine’s agent link at this computer’s agent, survives a reconnect, and stops', { timeout: 300_000, skip: !canSsh || !existsSync(bundle) || !process.env.SSH_AUTH_SOCK }, async () => {
  const localHome = mkdtempSync(path.join(tmpdir(), 'dl-'));
  const remoteHome = mkdtempSync('/tmp/dr-');
  rmSync(remoteHome, { recursive: true });
  const controlDir = mkdtempSync('/tmp/dc-'); // a scratch control socket, not one under the real ~/.dolphin-desktop
  const controlPath = path.join(controlDir, '%C');
  const { TMUX: _tmux, TMUX_PANE: _pane, ...inherited } = process.env;
  const app = await launchApp(localHome, {
    ...inherited, DOLPHIN_HOME: localHome, DOLPHIN_DESKTOP_REMOTE_HOME: remoteHome, DOLPHIN_GBRAIN: 'off', DOLPHIN_TMUX_IMPORT: 'off', DOLPHIN_DESKTOP_REMOTE_ENV: 'DOLPHIN_GBRAIN=off DOLPHIN_TMUX_IMPORT=off', DOLPHIN_DESKTOP_SSH_OPTIONS: `${SSH_TEST_OPTIONS} -o ControlPath=${controlPath}`, ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
  });
  const link = path.join(remoteHome, 'run', 'agent.sock');
  const exists = () => { try { lstatSync(link); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
  const target = () => (exists() ? readlinkSync(link) : null);
  const sockets = new Set();
  try {
    const window = await app.firstWindow();
    await window.waitForURL(/desktop\.html/, { timeout: 90_000 });
    await connectFromSidebar(window, 'localhost');
    await connected(window, 'localhost').waitFor({ timeout: 150_000 });
    assert.equal(exists(), false, 'off by default');
    assert.equal(await window.evaluate(() => window.dolphinDesktop.machineList().find((m) => m.id === 'localhost').agentForwarding), false);

    await section(window, 'localhost').getByRole('button', { name: 'localhost options' }).click();
    const toggle = window.getByRole('menuitemcheckbox', { name: /Forward SSH agent/ });
    assert.equal(await toggle.getAttribute('aria-checked'), 'false');
    await toggle.click();
    assert.ok(await until(exists), 'the link appears');
    assert.ok(lstatSync(link).isSymbolicLink());
    const first = target();
    sockets.add(first);
    assert.notEqual(spawnSync('ssh-add', ['-l'], { env: { ...process.env, SSH_AUTH_SOCK: link } }).status, 2, 'the agent answers through the link');
    await window.waitForFunction(() => window.dolphinDesktop.machineList().find((m) => m.id === 'localhost').agentForwarding === true, null, { timeout: 10_000 });
    await window.getByRole('menuitemcheckbox', { name: /Forward SSH agent/, checked: true }).waitFor({ timeout: 10_000 });
    const saved = JSON.parse(readFileSync(path.join(localHome, 'profile', 'settings.json'), 'utf8'));
    assert.deepEqual(saved.agentForwarding, { localhost: true });
    assert.equal(keepersFor(sockets).length, 1, 'one keeper holds the agent');
    await window.keyboard.press('Escape');

    // The link drops and comes back: a new keeper replaces the old one, never beside it.
    await window.evaluate(() => { window.__states = []; window.dolphinDesktop.onMachineList((list) => window.__states.push(list.find((m) => m.id === 'localhost')?.state)); });
    execFileSync('ssh', ['-o', `ControlPath=${controlPath}`, '-O', 'exit', 'localhost'], { stdio: 'ignore' });
    await window.waitForFunction(() => window.__states.includes('reconnecting') && window.__states.at(-1) === 'connected', null, { timeout: 90_000 });
    assert.ok(await until(() => target() !== first), 'the link points at the new connection’s agent');
    sockets.add(target());
    assert.ok(await until(() => keepersFor(sockets).length === 1), `one keeper after the reconnect, found ${keepersFor(sockets).length}`);

    assert.deepEqual(await window.evaluate(() => window.dolphinDesktop.setAgentForwarding('localhost', false)), { ok: true });
    assert.equal(exists(), false, 'turning it off removes the link');
    assert.ok(await until(() => keepersFor(sockets).length === 0), 'no keeper is left on the machine');
    assert.deepEqual(JSON.parse(readFileSync(path.join(localHome, 'profile', 'settings.json'), 'utf8')).agentForwarding, { localhost: false });
  } finally {
    await teardown({
      app,
      helpers: [remoteHome, localHome],
      cleanup: [
        () => { spawnSync('ssh', ['-o', `ControlPath=${controlPath}`, '-O', 'exit', 'localhost'], { stdio: 'ignore' }); }, // no master is fine
        () => {
          const left = keepersFor(sockets);
          for (const pid of left) process.kill(pid, 'SIGKILL');
          if (left.length) throw new Error(`agent keepers outlived the test: ${left.join(', ')}; killed them`);
        },
      ],
      remove: [localHome, remoteHome, controlDir],
    });
  }
});
