import { describe, expect, it } from 'vitest';
import { formatTokens, usageLines, windowLabel } from './usageModel';
import type { AgentUsage } from './types';

const hhmm = (date: Date) => date.toISOString().slice(11, 16);

describe('usage model', () => {
  it('formats token counts compactly', () => {
    expect([950, 1234, 12345, 1_234_567, 12_345_678].map(formatTokens)).toEqual(['950', '1.2k', '12k', '1.2M', '12M']);
  });
  it('names limit windows', () => {
    expect([300, 10080, 60, 2880, 45].map(windowLabel)).toEqual(['5 hours', '7 days', '1 hour', '2 days', '45 min']);
  });
  it('describes an active window, the week and reported limits', () => {
    const agent: AgentUsage = {
      agent: 'codex', found: true,
      five_hour: { tokens: 1_500_000, started_at: '2026-10-12T12:00:00Z', ends_at: '2026-10-12T17:00:00Z', burn_per_minute: 8100 },
      seven_day: { tokens: 9_400_000 },
      limits: [{ window_minutes: 300, used_percent: 42.4, resets_at: '2026-10-12T15:00:00Z' }],
    };
    expect(usageLines(agent, hhmm, new Date('2026-10-12T13:00:00Z'))).toEqual([
      '5-hour window: 1.5M tokens, 8.1k a minute, resets at 17:00',
      '7 days: 9.4M tokens',
      'Limit, 5 hours: 42% used, resets at 15:00',
    ]);
  });
  it('says when no window is running', () => {
    expect(usageLines({ agent: 'claude', found: true, five_hour: null, seven_day: { tokens: 0 }, limits: [] }, hhmm))
      .toEqual(['5-hour window: not started', '7 days: 0 tokens']);
  });
  it('picks the unit after rounding', () => {
    expect([999, 999_999, 9_999, 9_999_999].map(formatTokens)).toEqual(['999', '1.0M', '10k', '10M']);
  });
  it('leaves out an unknown burn rate', () => {
    const agent: AgentUsage = { agent: 'claude', found: true, five_hour: { tokens: 5, started_at: null, ends_at: null, burn_per_minute: null }, seven_day: { tokens: 5 }, limits: [] };
    expect(usageLines(agent, hhmm)[0]).toBe('5-hour window: 5 tokens');
  });
  it('reads past and unparseable times without inventing a reset', () => {
    const now = new Date('2026-10-12T16:00:00Z');
    const agent: AgentUsage = {
      agent: 'codex', found: true,
      five_hour: { tokens: 10, started_at: null, ends_at: '2026-10-12T15:00:00Z', burn_per_minute: 1 },
      seven_day: { tokens: 10 },
      limits: [{ window_minutes: 300, used_percent: 10, resets_at: '2026-10-12T14:00:00Z' }, { window_minutes: 60, used_percent: 5, resets_at: 'garbage' }],
    };
    expect(usageLines(agent, hhmm, now)).toEqual([
      '5-hour window: 10 tokens, 1 a minute, window ended',
      '7 days: 10 tokens',
      'Limit, 5 hours: 10% used, reset',
      'Limit, 1 hour: 5% used',
    ]);
  });
});
