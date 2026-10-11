// The static pages (connect, status, prompts) run inline scripts that no
// bundler or type checker sees, so a syntax error there would only show as a
// dead window. Parse each one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Script } from 'node:vm';

const dir = path.join(import.meta.dirname, '..', 'static');

test('every inline script in static/*.html parses', () => {
  const pages = readdirSync(dir).filter((name) => name.endsWith('.html'));
  assert.ok(pages.length > 0);
  for (const page of pages) {
    const html = readFileSync(path.join(dir, page), 'utf8');
    for (const [, body] of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
      assert.doesNotThrow(() => new Script(body, { filename: page }), `${page} has a script that does not parse`);
    }
  }
});
