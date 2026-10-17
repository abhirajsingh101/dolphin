// The theme the workspace sends to the main process (theme.ts): kept across
// launches, and painted with the workspace's own glass colours.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isThemeChoice, readTheme, THEME_FILE, WINDOW_COLORS, writeTheme } from '../dist/theme.js';

test('the choice is kept, and anything else reads as System', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dtheme-'));
  try {
    assert.equal(readTheme(dir), 'system');
    writeTheme(dir, 'dark');
    assert.equal(readTheme(dir), 'dark');
    for (const raw of ['{oops', '[]', '{"theme":"sepia"}', '{"theme":3}']) {
      writeFileSync(path.join(dir, THEME_FILE), raw);
      assert.equal(readTheme(dir), 'system');
    }
    assert.deepEqual(['system', 'light', 'dark', 'auto', null].map(isThemeChoice), [true, true, true, false, false]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('window colours are the glass backdrop and text from tokens.css', () => {
  const tokens = readFileSync(path.join(import.meta.dirname, '..', '..', 'dolphin-web', 'src', 'tokens.css'), 'utf8');
  const value = (block, name) => block.match(new RegExp(`${name}:\\s*([^;]+);`))[1].trim();
  const light = tokens.slice(0, tokens.indexOf(":root[data-theme='dark']"));
  const dark = tokens.slice(tokens.indexOf(":root[data-theme='dark']"));
  assert.deepEqual(WINDOW_COLORS, {
    light: { background: value(light, '--glass-bg'), symbol: value(light, '--glass-text') },
    dark: { background: value(dark, '--glass-bg'), symbol: value(dark, '--glass-text') },
  });
});
