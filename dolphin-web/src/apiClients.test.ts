import { describe, expect, it } from 'vitest';
import { apiFor, pruneClients } from './api';

describe('per-machine API clients', () => {
  it('keeps one client per live endpoint and forgets the rest', () => {
    const a = { base: 'http://127.0.0.1:41001', token: 'a' };
    const b = { base: 'http://127.0.0.1:41002', token: 'b' };
    const first = apiFor(a);
    expect(apiFor(a)).toBe(first);
    const second = apiFor(b);
    pruneClients([b]);
    expect(apiFor(b)).toBe(second);
    expect(apiFor(a)).not.toBe(first);
  });
});
