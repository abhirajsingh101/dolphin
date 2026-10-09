import { describe, expect, it } from 'vitest';

import {
  formatTranscriptForInsertion,
  sanitizeNativeTranscript,
  sanitizeTerminalTranscript,
} from './dictationTarget';

describe('dictation transcript sanitizing', () => {
  it('removes terminal control characters and flattens lines', () => {
    expect(sanitizeTerminalTranscript(' hello\nworld\u001b[31m\t ')).toBe(
      'hello world[31m',
    );
  });

  it('preserves safe newlines for native text areas', () => {
    expect(sanitizeNativeTranscript(' first\r\nsecond\u0007 ')).toBe(
      'first\nsecond',
    );
  });
});

describe('formatTranscriptForInsertion', () => {
  it('adds a word boundary when appending to existing text', () => {
    expect(formatTranscriptForInsertion('hello', 5, 5, 'world.')).toBe(' world.');
  });

  it('does not add a space before punctuation', () => {
    expect(formatTranscriptForInsertion('hello', 5, 5, '.')).toBe('.');
  });

  it('spaces an insertion from text on both sides', () => {
    expect(formatTranscriptForInsertion('onetwo', 3, 3, 'middle')).toBe(
      ' middle ',
    );
  });
});

