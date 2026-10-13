import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionState, STATE_LABEL } from './sessionState';

const base = { observation_state: 'available' as const };
const at = '2026-10-12T08:00:00Z';

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, String(value)); },
    removeItem: (key: string) => { map.delete(key); },
  };
}

describe('sessionState', () => {
  it('error wins: a dead pane or a session that could not be read', () => {
    expect(sessionState({ ...base, pane_dead: true, turn_state: 'working', turn_at: at }, undefined)).toBe('error');
    expect(sessionState({ observation_state: 'degraded', turn_state: 'working', turn_at: at }, undefined)).toBe('error');
  });
  it('working while the agent has a turn in progress', () => {
    expect(sessionState({ ...base, turn_state: 'working', turn_at: at }, Date.parse(at) + 1)).toBe('working');
  });
  it('unread until it is seen after the turn finished', () => {
    const finished = { ...base, turn_state: 'finished' as const, turn_at: at };
    expect(sessionState(finished, undefined)).toBe('unread');
    expect(sessionState(finished, Date.parse(at) - 1)).toBe('unread');
    expect(sessionState(finished, Date.parse(at))).toBe('idle');
  });
  it('idle with no hook state, or a turn time that does not parse', () => {
    expect(sessionState(base, undefined)).toBe('idle');
    expect(sessionState({ ...base, turn_state: null, turn_at: null }, undefined)).toBe('idle');
    expect(sessionState({ ...base, turn_state: 'finished', turn_at: 'yesterday' }, undefined)).toBe('idle');
  });
  it('labels every state', () => {
    expect(Object.keys(STATE_LABEL).sort()).toEqual(['error', 'idle', 'unread', 'working']);
  });
});

describe('markSeen', () => {
  const now = Date.parse('2026-10-12T09:00:00Z');
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('localStorage', memoryStorage());
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('stores one time per machine, project and session', async () => {
    const seen = await import('./sessionState');
    seen.markSeen('gpu-box', 'atlas', 'build');
    expect(seen.seenAt('gpu-box', 'atlas', 'build')).toBe(now);
    expect(seen.seenAt('local', 'atlas', 'build')).toBeUndefined();
    expect(JSON.parse(localStorage.getItem('dolphin.seen-turns')!)).toEqual({ 'gpu-box|atlas|build': now });
  });

  it('a remote clock ahead of this one still counts as seen', async () => {
    const seen = await import('./sessionState');
    const ahead = new Date(now + 60_000).toISOString();
    seen.markSeen('gpu-box', 'atlas', 'build', ahead);
    const s = { observation_state: 'available' as const, turn_state: 'finished' as const, turn_at: ahead };
    expect(seen.sessionState(s, seen.seenAt('gpu-box', 'atlas', 'build'))).toBe('idle');
  });

  it('a remote clock behind this one still shows its next turn as unread', async () => {
    const seen = await import('./sessionState');
    const first = new Date(now - 5 * 60_000).toISOString();
    seen.markSeen('gpu-box', 'atlas', 'build', first);
    const next = new Date(now - 5 * 60_000 + 60_000).toISOString();
    const s = { observation_state: 'available' as const, turn_state: 'finished' as const, turn_at: next };
    expect(seen.sessionState({ ...s, turn_at: first }, seen.seenAt('gpu-box', 'atlas', 'build'))).toBe('idle');
    expect(seen.sessionState(s, seen.seenAt('gpu-box', 'atlas', 'build'))).toBe('unread');
  });

  it('a turn time replaces an earlier local-clock seen value', async () => {
    const seen = await import('./sessionState');
    seen.markSeen('gpu-box', 'atlas', 'build');
    const turn = new Date(now - 10 * 60_000).toISOString();
    seen.markSeen('gpu-box', 'atlas', 'build', turn);
    const next = new Date(now - 9 * 60_000).toISOString();
    const s = { observation_state: 'available' as const, turn_state: 'finished' as const, turn_at: next };
    expect(seen.sessionState(s, seen.seenAt('gpu-box', 'atlas', 'build'))).toBe('unread');
  });

  it('keeps the newest 500 sessions', async () => {
    const seen = await import('./sessionState');
    for (let i = 0; i < 501; i += 1) {
      vi.setSystemTime(now + i);
      seen.markSeen('local', 'p', `s${i}`);
    }
    const stored = JSON.parse(localStorage.getItem('dolphin.seen-turns')!);
    expect(Object.keys(stored)).toHaveLength(500);
    expect(stored['local|p|s0']).toBeUndefined();
    expect(stored['local|p|s500']).toBe(now + 500);
  });

  it('still works when storage refuses', async () => {
    vi.stubGlobal('localStorage', { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } });
    const seen = await import('./sessionState');
    seen.markSeen('local', 'p', 's');
    expect(seen.seenAt('local', 'p', 's')).toBe(now);
  });
});
