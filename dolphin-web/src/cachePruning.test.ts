import { describe, expect, it } from 'vitest';
import { pickKeys, rememberBounded } from './cachePruning';

describe('cache pruning', () => {
  it('keeps only the live machines, and the same object when nothing goes', () => {
    const record = { local: 1, 'gpu-box': 2, gone: 3 };
    expect(pickKeys(record, ['local', 'gpu-box'])).toEqual({ local: 1, 'gpu-box': 2 });
    expect(pickKeys(record, ['local', 'gpu-box', 'gone'])).toBe(record);
  });

  it('forgets the oldest entries past the limit, and refreshes a repeated one', () => {
    const seen = new Set<string>();
    for (const value of ['a', 'b', 'c']) rememberBounded(seen, value, 3);
    rememberBounded(seen, 'a', 3);
    rememberBounded(seen, 'd', 3);
    expect([...seen]).toEqual(['c', 'a', 'd']);
  });
});
