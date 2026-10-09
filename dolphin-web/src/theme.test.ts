// This project pins "typescript": "latest"; with the TypeScript version that
// currently resolves to, tsc's automatic "include every @types package"
// discovery does not pick up @types/node's default type entry (other @types
// packages here, e.g. @types/react, are auto-included fine). An explicit
// reference makes tsc load it directly, without touching tsconfig.json.
/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

import { describe, expect, it } from 'vitest';

import {
  THEME_STORAGE_KEY,
  type ThemeChoice,
  nextChoice,
  readStoredChoice,
  resolveTheme,
} from './theme';

describe('resolveTheme', () => {
  it('follows the OS when the choice is system', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });

  it('lets an explicit choice override the OS', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });
});

describe('readStoredChoice', () => {
  it('defaults to system when nothing is stored', () => {
    expect(readStoredChoice(null)).toBe('system');
  });

  it('ignores values it does not recognise', () => {
    expect(readStoredChoice('neon')).toBe('system');
  });

  it('restores a valid stored choice', () => {
    expect(readStoredChoice('dark')).toBe('dark');
  });

  it('restores the other two valid stored choices', () => {
    expect(readStoredChoice('system')).toBe('system');
    expect(readStoredChoice('light')).toBe('light');
  });
});

describe('nextChoice', () => {
  it('cycles system to light to dark and back', () => {
    expect(nextChoice('system')).toBe('light');
    expect(nextChoice('light')).toBe('dark');
    expect(nextChoice('dark')).toBe('system');
  });

  it('treats an unrecognised value as wrapping to system (indexOf -1 -> 0)', () => {
    expect(nextChoice('neon' as ThemeChoice)).toBe('system');
  });
});

describe('THEME_STORAGE_KEY', () => {
  it('is namespaced to the app', () => {
    expect(THEME_STORAGE_KEY).toBe('dolphin.theme');
  });
});

describe('public/theme-init.js parity with theme.ts', () => {
  const themeInitPath = resolve(__dirname, '../public/theme-init.js');
  const source = readFileSync(themeInitPath, 'utf8');

  it('is a real, non-empty file (fails loudly, not vacuously)', () => {
    expect(source.length).toBeGreaterThan(0);
    expect(source).toContain('data-theme');
  });

  /**
   * theme-init.js intentionally duplicates readStoredChoice()/resolveTheme()
   * so it can run before any module loads (see its header comment). Nothing
   * enforces that the two stay in sync except this test: it executes the
   * actual file content in a sandboxed VM context and asserts it sets the
   * same data-theme value theme.ts's pure functions would compute, across a
   * matrix of stored values (including invalid/wrong-case input) and both
   * OS preference states.
   */
  function runThemeInitScript(
    storedValue: string | null,
    prefersDark: boolean,
  ): string | null {
    let dataTheme: string | null = null;
    const sandbox = {
      localStorage: {
        getItem: (key: string) => (key === THEME_STORAGE_KEY ? storedValue : null),
      },
      window: {
        matchMedia: (_query: string) => ({ matches: prefersDark }),
      },
      document: {
        documentElement: {
          setAttribute: (name: string, value: string) => {
            if (name === 'data-theme') dataTheme = value;
          },
        },
      },
    };
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox);
    return dataTheme;
  }

  const storedValues: Array<string | null> = [
    null,
    '',
    'neon',
    'system',
    'light',
    'dark',
    'Dark',
  ];

  for (const stored of storedValues) {
    for (const prefersDark of [true, false]) {
      it(`agrees with resolveTheme(readStoredChoice(...)) for stored=${JSON.stringify(stored)}, prefersDark=${prefersDark}`, () => {
        const actual = runThemeInitScript(stored, prefersDark);
        const expected = resolveTheme(readStoredChoice(stored), prefersDark);
        expect(actual).toBe(expected);
      });
    }
  }
});
