/* Desktop settings (spec: "Settings"), in <userData>/settings.json. The page
 * reaches them through dolphinDesktop.settings (preload.ts); the main process
 * reads them for the update channel, memory and crash reports. Fields that are
 * not valid are dropped, so a hand-edited or half-written file never breaks a
 * launch. Reads and writes go through session-store's readJson/writeJsonAtomic
 * (the one atomic writer). Keys this version does not know stay in the file. */

import path from 'node:path';

import { validTarget } from './machines';
import { readJson, writeJsonAtomic } from './session-store';

export type DesktopSettings = {
  updateChannel: 'stable' | 'beta';
  memory: boolean;
  crashReports: 'off' | 'local';
  /** Per machine id: forward the local SSH agent to that machine. */
  agentForwarding: Record<string, boolean>;
};
export const DEFAULT_SETTINGS: DesktopSettings = { updateChannel: 'stable', memory: false, crashReports: 'local', agentForwarding: {} };
export const SETTINGS_FILE = 'settings.json';

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const MAX_FORWARDING_KEYS = 200;
const MAX_KEY_LENGTH = 255;
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
/** A machine id: 'local' or an SSH target (machines.ts validTarget). */
const machineId = (key: string) => key.length <= MAX_KEY_LENGTH && !RESERVED_KEYS.has(key) && (key === 'local' || validTarget(key));
const booleanMap = (value: unknown): value is Record<string, boolean> =>
  isObject(value) && Object.keys(value).length <= MAX_FORWARDING_KEYS && Object.entries(value).every(([key, entry]) => machineId(key) && typeof entry === 'boolean');
/** The machine-id entries of a map of booleans; a map with a non-boolean value or too many keys is dropped whole. */
function cleanForwarding(value: unknown): Record<string, boolean> | undefined {
  if (!isObject(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.length > MAX_FORWARDING_KEYS || entries.some(([, entry]) => typeof entry !== 'boolean')) return undefined;
  return Object.fromEntries(entries.filter(([key]) => machineId(key))) as Record<string, boolean>;
}

const CHECKS: { [K in keyof DesktopSettings]: (value: unknown) => boolean } = {
  updateChannel: (value) => value === 'stable' || value === 'beta',
  memory: (value) => typeof value === 'boolean',
  crashReports: (value) => value === 'off' || value === 'local',
  agentForwarding: booleanMap,
};

/** The fields of `raw` that are valid settings. */
export function validSettings(raw: unknown): Partial<DesktopSettings> {
  const value = isObject(raw) ? raw : {};
  const valid: Record<string, unknown> = {};
  for (const key of Object.keys(CHECKS) as (keyof DesktopSettings)[]) {
    if (!(key in value)) continue;
    if (key === 'agentForwarding') {
      const map = cleanForwarding(value[key]);
      if (map) valid[key] = map;
    } else if (CHECKS[key](value[key])) valid[key] = value[key];
  }
  return valid as Partial<DesktopSettings>;
}

/** True when `raw` is an object and every setting it names has a valid value
 *  (names this version does not know are ignored). */
export function patchIsValid(raw: unknown): boolean {
  return isObject(raw) && (Object.keys(CHECKS) as (keyof DesktopSettings)[]).every((key) => !(key in raw) || CHECKS[key](raw[key]));
}

export function readSettings(dir: string): DesktopSettings {
  return { ...DEFAULT_SETTINGS, agentForwarding: {}, ...validSettings(readJson<unknown>(path.join(dir, SETTINGS_FILE), {})) };
}

/** Merge the valid fields of `patch` into the saved settings; returns what is
 *  saved. A folder that cannot be written keeps what is on disk. */
export function writeSettings(dir: string, patch: unknown): DesktopSettings {
  const file = path.join(dir, SETTINGS_FILE);
  const previous = readSettings(dir);
  const next = { ...previous, ...validSettings(patch) };
  try {
    writeJsonAtomic(file, { ...readRawSettings(dir), ...next });
  } catch {
    return readSettings(dir);
  }
  for (const listener of [...listeners]) {
    try { listener(next, previous); } catch { /* a listener never breaks a write */ }
  }
  return next;
}

/** The settings file as written (unknown keys and invalid values included); {} when missing, broken or not an object. */
export function readRawSettings(dir: string): Record<string, unknown> {
  const raw = readJson<unknown>(path.join(dir, SETTINGS_FILE), {});
  return isObject(raw) ? raw : {};
}

type Listener = (next: DesktopSettings, previous: DesktopSettings) => void;
const listeners = new Set<Listener>();
/** Call `listener` after every successful write; returns the function that stops it. */
export function onSettingsChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
