import { useEffect, useState } from 'react';
import { SETTINGS_EVENT, THEME_STORAGE_KEY, persistTheme, readStoredTheme } from './theme';

/* Renderer settings (spec "Settings"): one JSON object in localStorage
   `dolphin.settings`. A missing, malformed or out-of-range value reads as its
   default, so a bad write never breaks the app. The Settings screen (layout
   area) builds on this file. */

export type Settings = {
  theme: 'system' | 'light' | 'dark';
  'terminal.fontSize': number;
  /** What + starts: `ask` shows the New Session choices every time. `shell` is a tmux session; `terminal` a plain one. */
  'newSession.defaultAgent': 'ask' | 'claude' | 'codex' | 'shell' | 'terminal';
  'notifications.system': boolean;
};
export type SettingKey = keyof Settings;
export type SettingValue<K extends SettingKey> = Settings[K];

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  'terminal.fontSize': 13,
  'newSession.defaultAgent': 'ask',
  'notifications.system': true,
};

export const TERMINAL_FONT_SIZE_MIN = 9;
export const TERMINAL_FONT_SIZE_MAX = 24;

const KEY = 'dolphin.settings';
const EVENT = SETTINGS_EVENT;

const VALID: { [K in SettingKey]: (value: unknown) => boolean } = {
  theme: (v) => v === 'system' || v === 'light' || v === 'dark',
  'terminal.fontSize': (v) => typeof v === 'number' && Number.isInteger(v) && v >= TERMINAL_FONT_SIZE_MIN && v <= TERMINAL_FONT_SIZE_MAX,
  'newSession.defaultAgent': (v) => v === 'ask' || v === 'claude' || v === 'codex' || v === 'shell' || v === 'terminal',
  'notifications.system': (v) => typeof v === 'boolean',
};

// Changes made while storage refuses still hold for this window.
const memory: Partial<Settings> = {};
// Another Dolphin window changed the settings in the storage they share: its
// values win over this window's copies. Registered before any listener that
// re-reads them.
globalThis.addEventListener?.('storage', (event: Event) => {
  const key = (event as StorageEvent).key;
  if (key !== KEY && key !== THEME_STORAGE_KEY && key !== null) return;
  for (const name of Object.keys(memory) as SettingKey[]) delete memory[name];
});

function stored(): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

// `dolphin.theme` is the source of truth for `theme`: the theme toggle and
// theme-init.js (before first paint) use it, and it is shared via readStoredTheme.
function themeValue(): Settings['theme'] {
  try {
    if (globalThis.localStorage?.getItem(THEME_STORAGE_KEY) !== null) return readStoredTheme();
  } catch { /* fall through to memory */ }
  return memory.theme ?? DEFAULT_SETTINGS.theme;
}

export function getSetting<K extends SettingKey>(key: K): SettingValue<K> {
  if (key === 'theme') return themeValue() as SettingValue<K>;
  const value = key in memory ? memory[key] : stored()[key];
  return VALID[key](value) ? value as SettingValue<K> : DEFAULT_SETTINGS[key];
}

export function setSetting<K extends SettingKey>(key: K, value: SettingValue<K>): void {
  if (!VALID[key](value)) throw new RangeError(`Invalid value for ${key}`);
  memory[key] = value;
  try { globalThis.localStorage?.setItem(KEY, JSON.stringify({ ...stored(), [key]: value })); } catch { /* storage is optional */ }
  if (key === 'theme') persistTheme(value as Settings['theme']);
  // persistTheme has already fired the event for `theme`.
  if (globalThis.dispatchEvent) {
    if (key !== 'theme') globalThis.dispatchEvent(new Event(EVENT));
  } else {
    for (const listener of [...direct]) listener();
  }
}

/* One notification path: SETTINGS_EVENT on window (setSetting and the theme
   toggle both fire it) plus `storage` for other windows. Without a DOM there is
   no event to hear, so setSetting calls these directly instead. */
const direct = new Set<() => void>();

export function subscribeSettings(listener: () => void): () => void {
  const target = globalThis.window as Window | undefined;
  const onStorage = (event: Event) => {
    const key = (event as StorageEvent).key;
    if (key === null || key === KEY) listener();
  };
  direct.add(listener);
  target?.addEventListener?.(EVENT, listener);
  target?.addEventListener?.('storage', onStorage);
  return () => {
    direct.delete(listener);
    target?.removeEventListener?.(EVENT, listener);
    target?.removeEventListener?.('storage', onStorage);
  };
}

/** Tests only: forget this window's in-memory changes, as a reload would. */
export function resetSettingsForTests(): void {
  for (const key of Object.keys(memory) as SettingKey[]) delete memory[key];
}

export function useSetting<K extends SettingKey>(key: K): [SettingValue<K>, (value: SettingValue<K>) => void] {
  const [value, setValue] = useState(() => getSetting(key));
  useEffect(() => {
    const sync = () => setValue(getSetting(key));
    window.addEventListener(EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, [key]);
  return [value, (next) => setSetting(key, next)];
}
