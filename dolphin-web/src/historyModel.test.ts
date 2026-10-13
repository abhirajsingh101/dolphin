import { describe, expect, it } from 'vitest';
import { highlight, timeAgo } from './historyModel';

describe('history model', () => {
  const now = new Date('2026-10-12T12:00:00Z');
  it('says how long ago', () => {
    expect(['2026-10-12T11:59:40Z', '2026-10-12T11:35:00Z', '2026-10-12T07:00:00Z', '2026-10-11T10:00:00Z', '2026-10-07T12:00:00Z']
      .map((iso) => timeAgo(iso, now))).toEqual(['just now', '25 min ago', '5 h ago', 'yesterday', '5 days ago']);
  });
  it('marks every match, ignoring case', () => {
    expect(highlight('Login then LOGIN', 'login')).toEqual([
      { text: 'Login', match: true }, { text: ' then ', match: false }, { text: 'LOGIN', match: true },
    ]);
    expect(highlight('nothing here', '')).toEqual([{ text: 'nothing here', match: false }]);
  });
});
