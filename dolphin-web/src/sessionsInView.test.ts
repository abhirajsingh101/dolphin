import { describe, expect, it } from 'vitest';
import { sessionsInViewLabel } from './sessionsInView';

describe('sessionsInViewLabel', () => {
  it('uses the singular for exactly one session', () => {
    expect(sessionsInViewLabel(1)).toBe('1 session in view');
  });
  it('uses the plural for zero and many', () => {
    expect(sessionsInViewLabel(0)).toBe('0 sessions in view');
    expect(sessionsInViewLabel(7)).toBe('7 sessions in view');
  });
});
