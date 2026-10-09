import { describe, expect, it } from 'vitest';

import {
  isTerminalLikeTarget,
  isTypingTarget,
  TYPING_CONTAINER_SELECTOR,
} from './shortcutTarget';

const inContainer = (selector: string) => ({
  tagName: 'DIV',
  closest: (query: string) => (query === TYPING_CONTAINER_SELECTOR ? {} : null),
  _selector: selector,
});

describe('isTypingTarget', () => {
  it('treats a null target as safe to handle', () => {
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget(undefined)).toBe(false);
  });

  it.each(['INPUT', 'TEXTAREA', 'SELECT'])('suppresses inside %s', (tagName) => {
    expect(isTypingTarget({ tagName })).toBe(true);
  });

  it('suppresses inside contenteditable', () => {
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
  });

  it('suppresses anywhere inside the xterm terminal', () => {
    expect(isTypingTarget(inContainer('.terminal-host'))).toBe(true);
  });

  it('suppresses anywhere inside a CodeMirror editor', () => {
    expect(isTypingTarget(inContainer('.cm-content'))).toBe(true);
  });

  it('allows shortcuts on a plain button', () => {
    expect(isTypingTarget({ tagName: 'BUTTON', closest: () => null })).toBe(false);
  });

  it('allows shortcuts on the document body', () => {
    expect(isTypingTarget({ tagName: 'BODY', closest: () => null })).toBe(false);
  });

  it('is case insensitive on tagName', () => {
    expect(isTypingTarget({ tagName: 'input' })).toBe(true);
  });
});

describe('TYPING_CONTAINER_SELECTOR', () => {
  it('covers the terminal and both editor surfaces', () => {
    expect(TYPING_CONTAINER_SELECTOR).toContain('.terminal-host');
    expect(TYPING_CONTAINER_SELECTOR).toContain('.xterm');
    expect(TYPING_CONTAINER_SELECTOR).toContain('.cm-content');
  });
});

describe('isTerminalLikeTarget', () => {
  it('treats a null target as not terminal-like', () => {
    expect(isTerminalLikeTarget(null)).toBe(false);
    expect(isTerminalLikeTarget(undefined)).toBe(false);
  });

  it('is true anywhere inside the xterm terminal', () => {
    expect(isTerminalLikeTarget(inContainer('.terminal-host'))).toBe(true);
  });

  it('is true anywhere inside a CodeMirror editor', () => {
    expect(isTerminalLikeTarget(inContainer('.cm-content'))).toBe(true);
  });

  it('is false for a plain INPUT that is not inside a terminal/editor', () => {
    expect(
      isTerminalLikeTarget({ tagName: 'INPUT', closest: () => null }),
    ).toBe(false);
  });

  it('is false for a plain TEXTAREA that is not inside a terminal/editor', () => {
    expect(
      isTerminalLikeTarget({ tagName: 'TEXTAREA', closest: () => null }),
    ).toBe(false);
  });

  it('is false for contenteditable outside a terminal/editor container', () => {
    expect(
      isTerminalLikeTarget({
        tagName: 'DIV',
        isContentEditable: true,
        closest: () => null,
      }),
    ).toBe(false);
  });

  it('is true for the xterm hidden helper textarea', () => {
    expect(isTerminalLikeTarget(inContainer('.xterm-helper-textarea'))).toBe(
      true,
    );
  });

  it('allows shortcuts on a plain button', () => {
    expect(isTerminalLikeTarget({ tagName: 'BUTTON', closest: () => null })).toBe(
      false,
    );
  });
});
