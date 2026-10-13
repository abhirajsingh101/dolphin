import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function memory(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, String(v)); }, removeItem: (k: string) => { map.delete(k); } };
}

describe('the settings store Settings is built on', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());

  it('has exactly the spec keys and defaults, and the font range 9–24', async () => {
    vi.stubGlobal('localStorage', memory());
    const settings = await import('./settings');
    expect(settings.DEFAULT_SETTINGS).toEqual({ theme: 'system', 'terminal.fontSize': 13, 'newSession.defaultAgent': 'claude', 'notifications.system': true });
    expect([settings.TERMINAL_FONT_SIZE_MIN, settings.TERMINAL_FONT_SIZE_MAX]).toEqual([9, 24]);
    expect(typeof settings.subscribeSettings).toBe('function');
  });

  it('reads garbage in storage as defaults', async () => {
    vi.stubGlobal('localStorage', memory({ 'dolphin.settings': '{"terminal.fontSize": 400, "newSession.defaultAgent": "vim"' }));
    const { getSetting } = await import('./settings');
    expect([getSetting('terminal.fontSize'), getSetting('newSession.defaultAgent')]).toEqual([13, 'claude']);
  });
});
