import { describe, expect, it } from 'vitest';

import { agentLabel, formatInstalls, headline, kindLabel, parseSuggestions, safeLink, shownSuggestions } from './skillSuggestionsModel';
import type { SkillSuggestion } from './types';

const row = (key: string, extra: Partial<SkillSuggestion> = {}): SkillSuggestion => ({
  key, kind: 'skill', name: key, source: 'skills.sh', url: `https://skills.sh/${key}`, install: `npx skills add ${key}`,
  reason: 'You work on React.', project: null, installs: 10, agent: 'any', ...extra,
});

describe('formatInstalls', () => {
  it('formats counts compactly with the right noun', () => {
    expect(formatInstalls(5700)).toBe('5.7K installs');
    expect(formatInstalls(1)).toBe('1 install');
    expect(formatInstalls(0)).toBe('0 installs');
    expect(formatInstalls(950)).toBe('950 installs');
    expect(formatInstalls(1_250_000)).toBe('1.3M installs');
  });
  it('says nothing for an unknown or nonsense count', () => {
    expect(formatInstalls(null)).toBeNull();
    expect(formatInstalls(-3)).toBeNull();
    expect(formatInstalls(Number.NaN)).toBeNull();
  });
});

describe('headline', () => {
  it('names the count and the kind', () => {
    expect(headline([row('a'), row('b'), row('c')])).toBe('3 skills that fit your recent work');
    expect(headline([row('a', { kind: 'plugin' })])).toBe('1 plugin that fits your recent work');
    expect(headline([row('a'), row('b', { kind: 'plugin' })])).toBe('2 skills and plugins that fit your recent work');
  });
});

describe('labels', () => {
  it('chips the kind and only a specific agent', () => {
    expect(kindLabel('skill')).toBe('Skill');
    expect(kindLabel('plugin')).toBe('Plugin');
    expect(agentLabel('claude')).toBe('Claude Code');
    expect(agentLabel('codex')).toBe('Codex');
    expect(agentLabel('any')).toBeNull();
  });
});

describe('safeLink', () => {
  it('opens only web pages', () => {
    expect(safeLink('https://github.com/a/b')).toBe('https://github.com/a/b');
    expect(safeLink('javascript:alert(1)')).toBeNull();
    expect(safeLink('file:///etc/passwd')).toBeNull();
    expect(safeLink('')).toBeNull();
  });
});

describe('parseSuggestions', () => {
  it('keeps well-formed items, drops broken and repeated ones', () => {
    const parsed = parseSuggestions({
      enabled: true, generated_at: '2026-10-16T00:00:00Z',
      items: [row('a'), { ...row('b'), kind: 'theme' }, { key: 'c' }, row('a'), { ...row('d'), agent: 'gemini', installs: 'many', project: '  ' }],
    });
    expect(parsed?.items.map((item) => item.key)).toEqual(['a', 'd']);
    expect(parsed?.items[1]).toMatchObject({ agent: 'any', installs: null, project: null });
    expect(parsed?.generated_at).toBe('2026-10-16T00:00:00Z');
  });
  it('is null for anything that is not the helper’s answer', () => {
    expect(parseSuggestions([])).toBeNull();
    expect(parseSuggestions(null)).toBeNull();
    expect(parseSuggestions({ items: [] })).toBeNull();
    expect(parseSuggestions({ enabled: true, items: {} })).toBeNull();
  });
});

describe('shownSuggestions', () => {
  const data = { enabled: true, generated_at: null, items: [row('a'), row('b'), row('c'), row('d')] };
  it('shows at most two, minus the dismissed', () => {
    expect(shownSuggestions(data, new Set()).map((item) => item.key)).toEqual(['a', 'b']);
    expect(shownSuggestions(data, new Set(['b'])).map((item) => item.key)).toEqual(['a', 'c']);
  });
  it('shows nothing while turned off or unknown', () => {
    expect(shownSuggestions({ ...data, enabled: false }, new Set())).toEqual([]);
    expect(shownSuggestions(null, new Set())).toEqual([]);
  });
});
