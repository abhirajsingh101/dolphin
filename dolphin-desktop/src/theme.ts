/* The theme every Dolphin window shows. The workspace keeps its choice (System,
 * Light or Dark) in the page; it sends it here, and the main process sets
 * nativeTheme.themeSource to it. That one switch reaches what the page cannot:
 * the launch, Connect and SSH-prompt pages (static/style.css follows
 * prefers-color-scheme), the window's background before a page paints, and
 * the window controls drawn over the header on Linux and Windows. The choice
 * is kept in <userData>/theme.json, so the launch page opens in it too. */

import path from 'node:path';

import { readJson, writeJsonAtomic } from './session-store';

export type ThemeChoice = 'system' | 'light' | 'dark';
export const THEME_FILE = 'theme.json';
const CHOICES: readonly string[] = ['system', 'light', 'dark'];

export const isThemeChoice = (value: unknown): value is ThemeChoice => typeof value === 'string' && CHOICES.includes(value);

export function readTheme(dir: string): ThemeChoice {
  const { theme } = readJson<{ theme?: unknown }>(path.join(dir, THEME_FILE), {});
  return isThemeChoice(theme) ? theme : 'system';
}

/** Saves the choice; a folder that cannot be written keeps the old one. */
export function writeTheme(dir: string, theme: ThemeChoice): void {
  try {
    writeJsonAtomic(path.join(dir, THEME_FILE), { theme });
  } catch { /* the window still shows the choice; only the next launch forgets it */ }
}

/** dolphin-web's --glass-bg and --glass-text (tokens.css), per theme: the
 *  window's background before its page paints, and the window controls' ink.
 *  test/theme.test.mjs checks they match. */
export const WINDOW_COLORS = {
  light: { background: '#cbdcf0', symbol: '#192943' },
  dark: { background: '#091421', symbol: '#e7effb' },
} as const;

export const windowColors = (dark: boolean) => WINDOW_COLORS[dark ? 'dark' : 'light'];
