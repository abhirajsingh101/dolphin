// This project pins "typescript": "latest"; with the TypeScript version that
// currently resolves to, tsc's automatic "include every @types package"
// discovery does not pick up @types/node's default type entry (other @types
// packages here, e.g. @types/react, are auto-included fine). An explicit
// reference makes tsc load it directly, without touching tsconfig.json.
/// <reference types="node" />
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const FONT_DIR = resolve(__dirname, '../public/fonts');
const FONTS = ['Geist-Variable.woff2', 'GeistMono-Variable.woff2'];
const MAX_BYTES = 48 * 1024;

describe('self-hosted fonts', () => {
  it.each(FONTS)('%s exists and is a real woff2', (name) => {
    const buf = readFileSync(resolve(FONT_DIR, name));
    // woff2 magic number: 'wOF2'
    expect(buf.subarray(0, 4).toString('ascii')).toBe('wOF2');
  });

  it.each(FONTS)('%s stays under the size budget', (name) => {
    expect(statSync(resolve(FONT_DIR, name)).size).toBeLessThan(MAX_BYTES);
  });
});
