// Launch and teardown for the Electron tests. Nothing a test starts may
// outlive it: a helper whose `stop` failed is killed by its exact pid and the
// test fails, instead of the home being deleted with the helper still running
// (four 0.1.2 test helpers ran for days that way).
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { _electron as electron } from 'playwright';

export const root = path.resolve(import.meta.dirname, '..');
export const backend = path.resolve(root, '..', 'dolphin-backend');
export const venvPython = path.join(backend, 'venv', 'bin', 'python');
/** Options every ssh in an e2e test passes (DOLPHIN_DESKTOP_SSH_OPTIONS and
 *  direct calls): ssh never rewrites known_hosts with a host's newer keys, so
 *  a test leaves the user's known_hosts as it found it. */
export const SSH_TEST_OPTIONS = '-o UpdateHostKeys=no';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

/** The pid in a helper home's run/server.json, or null. */
export function helperPid(home) {
  try {
    const { pid } = JSON.parse(readFileSync(path.join(home, 'run', 'server.json'), 'utf8'));
    return Number.isInteger(pid) ? pid : null;
  } catch {
    return null;
  }
}

/** True when `pid` runs a Dolphin helper (frozen binary or `-m app.helper`). */
function isHelper(pid) {
  const result = spawnSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' });
  return /dolphin-helper|app\.helper/.test(result.stdout ?? '');
}

/** Quit Dolphin and wait for its process. Returns at once if it already
 *  exited; kills it and throws if it does not exit in time. */
export async function quitApp(app, timeoutMs = 15_000) {
  const child = app.process();
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined);
  const outcome = await Promise.race([exited.then(() => 'exited'), sleep(timeoutMs).then(() => 'hung')]);
  if (outcome === 'exited') return;
  child.kill('SIGKILL');
  await exited;
  throw new Error(`Dolphin did not quit within ${timeoutMs} ms; killed pid ${child.pid}.`);
}

/** Stop the helper serving from `home`, and prove it stopped. */
export async function stopHelper(home, { command = [venvPython, '-m', 'app.helper'], cwd = backend, env = process.env } = {}) {
  const pid = helperPid(home);
  const [binary, ...args] = command;
  const result = spawnSync(binary, [...args, 'stop'], { cwd, env: { ...env, DOLPHIN_HOME: home }, encoding: 'utf8', timeout: 20_000 });
  if (pid === null || !alive(pid)) return;
  for (let i = 0; i < 50 && alive(pid); i += 1) await sleep(100);
  if (!alive(pid)) return;
  const why = result.error ? result.error.message : `exit ${result.status}: ${(result.stderr || '').trim()}`;
  if (!isHelper(pid)) throw new Error(`pid ${pid} in ${home}/run/server.json is not a Dolphin helper; left alone (${why}).`);
  process.kill(pid, 'SIGKILL');
  throw new Error(`The helper in ${home} (pid ${pid}) outlived \`stop\` (${why}); killed it.`);
}

/** Every teardown step runs even when an earlier one throws; the errors are
 *  collected and thrown together at the end. Order: quit the app, stop each
 *  helper (`[home, options]` or `home`), run extra cleanups (e.g. the scratch
 *  tmux kill), then remove the directories. */
export async function teardown({ app, helpers = [], cleanup = [], remove = [] } = {}) {
  cleanup.forEach((run, index) => {
    if (typeof run !== 'function') throw new TypeError(`teardown: cleanup[${index}] must be a function, got ${Array.isArray(run) ? 'an array' : typeof run}`);
  });
  const errors = [];
  const step = async (run) => { try { await run(); } catch (error) { errors.push(error); } };
  if (app) await step(() => quitApp(app));
  for (const helper of helpers) {
    const [home, options] = Array.isArray(helper) ? helper : [helper];
    await step(() => stopHelper(home, options));
  }
  for (const run of cleanup) await step(run);
  for (const dir of remove) await step(() => rmSync(dir, { recursive: true, force: true }));
  if (errors.length) throw new AggregateError(errors, `Teardown failed: ${errors.map((e) => e.message).join('; ')}`);
}

/** An environment that keeps a test off the real machine. */
export function scratchEnv(home, extra = {}) {
  const { TMUX: _tmux, TMUX_PANE: _pane, ...inherited } = process.env;
  const tmuxDir = path.join(home, 'tmux');
  mkdirSync(tmuxDir, { recursive: true });
  return {
    ...inherited, HOME: home, DOLPHIN_HOME: path.join(home, '.dolphin-server'), TMUX_TMPDIR: tmuxDir, SHELL: '/bin/sh',
    DOLPHIN_WORKSPACE_ROOTS: home, DOLPHIN_GBRAIN: 'off', ELECTRON_DISABLE_SECURITY_WARNINGS: '1', ...extra,
  };
}

/** tmux on the test's own scratch server, never the user's. */
export function tmuxFor(env) {
  const socket = path.join(env.TMUX_TMPDIR, `tmux-${process.getuid()}`, 'default');
  mkdirSync(path.dirname(socket), { recursive: true, mode: 0o700 });
  return (...args) => execFileSync('tmux', ['-S', socket, ...args], { env, encoding: 'utf8' });
}

export function launchApp(home, env) {
  return electron.launch({ args: ['--no-sandbox', `--user-data-dir=${path.join(home, 'profile')}`, root], env });
}

/** Make every memory (GBrain) download in a test fail at once, offline. The
 *  helper runs those downloads with PATH=<DOLPHIN_HOME>/gbrain/bun:/usr/bin:/bin,
 *  so a fake curl on the test's own PATH is never reached; this one sits first. */
export function fakeGbrainDownloads(dolphinHome) {
  const dir = path.join(dolphinHome, 'gbrain', 'bun');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'curl'), '#!/bin/sh\necho "curl: (6) offline in this test" >&2\nexit 6\n');
  chmodSync(path.join(dir, 'curl'), 0o755);
}
