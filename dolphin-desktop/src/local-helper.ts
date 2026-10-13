/* This computer's helper, as its files describe it: run/server.json says
 * whether it is starting, ready or failed (app/helper.py), and
 * logs/helper.log says why it stopped. No Electron here
 * (test/local-helper.test.mjs). */

import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import path from 'node:path';

export type ServerState = 'starting' | 'ready' | 'failed';
export type ServerInfo = { state: ServerState; pid?: number; socket?: string; port?: number; started_at?: number; version?: string };

const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const str = (value: unknown) => (typeof value === 'string' && value ? value : undefined);

export function readServerInfo(home: string): ServerInfo | null {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(path.join(home, 'run', 'server.json'), 'utf8'));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const socket = str(raw.socket);
  const port = num(raw.port);
  // Helpers before 0.2.0 wrote no state, and only once they listened.
  const state: ServerState = raw.state === 'starting' || raw.state === 'ready' || raw.state === 'failed'
    ? raw.state
    : socket || port ? 'ready' : 'starting';
  return { state, pid: num(raw.pid), socket, port, started_at: num(raw.started_at), version: str(raw.version) };
}

export function pidAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export const helperLogFile = (home: string) => path.join(home, 'logs', 'helper.log');

/** The last `lines` lines of a log (read from its last 64 KB), or ''. */
export function logTail(file: string, lines = 20): string {
  try {
    const size = statSync(file).size;
    const start = Math.max(0, size - 64 * 1024);
    const buffer = Buffer.alloc(size - start);
    const descriptor = openSync(file, 'r');
    try {
      readSync(descriptor, buffer, 0, buffer.length, start);
    } finally {
      closeSync(descriptor);
    }
    const text = buffer.toString('utf8').trimEnd();
    return text ? text.split('\n').slice(-lines).join('\n') : '';
  } catch {
    return '';
  }
}

function explained(message: string, home: string): Error {
  const file = helperLogFile(home);
  const tail = logTail(file);
  return new Error(tail ? `${message}\n\nThe end of ${file}:\n${tail}` : `${message} Its log (${file}) is empty or missing.`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait for the helper `serve` just started (or found running). `before` is
 *  server.json as it was before `serve` ran, so a leftover from an earlier
 *  crash is never taken for this start failing. */
export async function waitForServer(home: string, before: ServerInfo | null, options: { timeoutMs: number; pollMs?: number }): Promise<{ socket: string; pid: number }> {
  const deadline = Date.now() + options.timeoutMs;
  const fresh = (info: ServerInfo) => !before || info.pid !== before.pid || info.started_at !== before.started_at;
  for (;;) {
    const info = readServerInfo(home);
    if (info?.state === 'ready' && info.socket && info.pid && pidAlive(info.pid) && existsSync(info.socket)) {
      return { socket: info.socket, pid: info.pid };
    }
    if (info && fresh(info) && (info.state === 'failed' || !pidAlive(info.pid))) {
      throw explained("Dolphin's helper stopped while starting.", home);
    }
    if (Date.now() >= deadline) {
      const seconds = Math.max(1, Math.round(options.timeoutMs / 1000));
      throw explained(`Dolphin's helper did not start within ${seconds} second${seconds === 1 ? '' : 's'}.`, home);
    }
    await sleep(options.pollMs ?? 100);
  }
}
