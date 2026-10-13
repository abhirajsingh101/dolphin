import { describe, expect, it } from 'vitest';
import { DolphinApiError } from './api';
import { panelError } from './useModalPanel';

describe('panelError', () => {
  it('names the helper for a 404 that carries no reason of its own', () => {
    for (const message of ['Not Found', '404 Not Found', 'Only available in Dolphin Desktop']) {
      expect(panelError(new DolphinApiError(message, 404))).toBe('This needs the Dolphin helper on that machine.');
    }
  });
  it('keeps a 404 that says what is missing, and every other error', () => {
    expect(panelError(new DolphinApiError('That tmux session is no longer available.', 404))).toBe('That tmux session is no longer available.');
    expect(panelError(new DolphinApiError('Not Found', 500))).toBe('Not Found');
    expect(panelError(new Error('offline'))).toBe('offline');
    expect(panelError('plain')).toBe('plain');
  });
});
