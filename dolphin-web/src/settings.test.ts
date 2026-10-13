import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, String(v)); } };
}

describe('settings', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());

  it('reads the spec defaults with nothing stored', async () => {
    vi.stubGlobal('localStorage', memoryStorage());
    const { DEFAULT_SETTINGS, getSetting } = await import('./settings');
    expect(DEFAULT_SETTINGS).toEqual({ theme: 'system', 'terminal.fontSize': 13, 'newSession.defaultAgent': 'claude', 'notifications.system': true });
    expect(getSetting('notifications.system')).toBe(true);
  });

  it('stores values in dolphin.settings and keeps the others', async () => {
    vi.stubGlobal('localStorage', memoryStorage({ 'dolphin.settings': JSON.stringify({ theme: 'dark' }) }));
    const { getSetting, setSetting } = await import('./settings');
    setSetting('notifications.system', false);
    expect(getSetting('notifications.system')).toBe(false);
    expect(JSON.parse(localStorage.getItem('dolphin.settings')!)).toEqual({ theme: 'dark', 'notifications.system': false });
  });

  it('a malformed or out-of-range value reads as its default', async () => {
    vi.stubGlobal('localStorage', memoryStorage({ 'dolphin.settings': JSON.stringify({ 'terminal.fontSize': 40, theme: 'blue', 'notifications.system': 'no' }) }));
    const { getSetting } = await import('./settings');
    expect(getSetting('terminal.fontSize')).toBe(13);
    expect(getSetting('theme')).toBe('system');
    expect(getSetting('notifications.system')).toBe(true);
  });

  it('a corrupt stored blob falls back to defaults', async () => {
    vi.stubGlobal('localStorage', memoryStorage({ 'dolphin.settings': '{nope' }));
    const { getSetting } = await import('./settings');
    expect(getSetting('terminal.fontSize')).toBe(13);
  });

  it('refuses to store an invalid value', async () => {
    vi.stubGlobal('localStorage', memoryStorage());
    const { setSetting } = await import('./settings');
    expect(() => setSetting('terminal.fontSize', 8)).toThrow(RangeError);
  });

  it('writes theme to dolphin.theme as well, for theme-init.js', async () => {
    vi.stubGlobal('localStorage', memoryStorage());
    const { setSetting, getSetting } = await import('./settings');
    setSetting('theme', 'dark');
    expect(localStorage.getItem('dolphin.theme')).toBe('dark');
    expect(getSetting('theme')).toBe('dark');
  });

  it('reads dolphin.theme, which the theme toggle writes alone', async () => {
    vi.stubGlobal('localStorage', memoryStorage({ 'dolphin.settings': JSON.stringify({ theme: 'light' }), 'dolphin.theme': 'dark' }));
    const { getSetting } = await import('./settings');
    expect(getSetting('theme')).toBe('dark');
  });

  it('persistTheme from the toggle notifies useSetting listeners', async () => {
    vi.stubGlobal('localStorage', memoryStorage());
    const seen = vi.fn();
    vi.stubGlobal('dispatchEvent', seen);
    const { persistTheme } = await import('./theme');
    persistTheme('dark');
    expect(seen).toHaveBeenCalled();
  });

  it('still remembers a change when storage refuses', async () => {
    vi.stubGlobal('localStorage', { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } });
    const { getSetting, setSetting } = await import('./settings');
    setSetting('notifications.system', false);
    expect(getSetting('notifications.system')).toBe(false);
  });
});

describe('settings subscribers', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());

  it('names the terminal font range once', async () => {
    const { TERMINAL_FONT_SIZE_MAX, TERMINAL_FONT_SIZE_MIN } = await import('./settings');
    expect([TERMINAL_FONT_SIZE_MIN, TERMINAL_FONT_SIZE_MAX]).toEqual([9, 24]);
  });

  it('calls each subscriber once per change, without a DOM, until it unsubscribes', async () => {
    vi.stubGlobal('localStorage', memoryStorage());
    const { setSetting, subscribeSettings } = await import('./settings');
    const listener = vi.fn();
    const unsubscribe = subscribeSettings(listener);
    setSetting('terminal.fontSize', 15);
    setSetting('theme', 'dark');
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    setSetting('theme', 'light');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('calls a subscriber once per change when the settings event reaches a window, theme included', async () => {
    const target = new EventTarget();
    vi.stubGlobal('window', target);
    vi.stubGlobal('dispatchEvent', (event: Event) => target.dispatchEvent(event));
    vi.stubGlobal('localStorage', memoryStorage());
    const { setSetting, subscribeSettings } = await import('./settings');
    const listener = vi.fn();
    subscribeSettings(listener);
    setSetting('terminal.fontSize', 15);
    setSetting('theme', 'dark');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('hears the theme toggle, which writes dolphin.theme alone', async () => {
    const target = new EventTarget();
    vi.stubGlobal('window', target);
    vi.stubGlobal('dispatchEvent', (event: Event) => target.dispatchEvent(event));
    vi.stubGlobal('localStorage', memoryStorage());
    const { subscribeSettings } = await import('./settings');
    const { persistTheme } = await import('./theme');
    const listener = vi.fn();
    subscribeSettings(listener);
    persistTheme('dark');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('does not call subscribers for a refused value', async () => {
    vi.stubGlobal('localStorage', memoryStorage());
    const { setSetting, subscribeSettings } = await import('./settings');
    const listener = vi.fn();
    subscribeSettings(listener);
    expect(() => setSetting('terminal.fontSize', 30)).toThrow(RangeError);
    expect(listener).not.toHaveBeenCalled();
  });

  it('hears another window writing dolphin.settings', async () => {
    const target = new EventTarget();
    vi.stubGlobal('window', target);
    vi.stubGlobal('localStorage', memoryStorage());
    const { subscribeSettings } = await import('./settings');
    const listener = vi.fn();
    subscribeSettings(listener);
    target.dispatchEvent(Object.assign(new Event('storage'), { key: 'dolphin.other' }));
    target.dispatchEvent(Object.assign(new Event('storage'), { key: 'dolphin.settings' }));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('resetSettingsForTests forgets in-memory changes', async () => {
    vi.stubGlobal('localStorage', { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } });
    const { getSetting, resetSettingsForTests, setSetting } = await import('./settings');
    setSetting('terminal.fontSize', 18);
    resetSettingsForTests();
    expect(getSetting('terminal.fontSize')).toBe(13);
  });
});
