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

// style.css cannot load dolphin-web's tokens.css, so it carries copies of the
// glass tokens. They drifted once (panel, bubble, shadow, the dark orb and
// accent) while the workspace moved on. Every copy must equal its source:
// --name here is --glass-name in tokens.css, except the names in SAME.
const tokensFile = path.join(import.meta.dirname, '..', '..', 'dolphin-web', 'src', 'tokens.css');
const SAME = new Set(['--danger', '--accent-on', '--fs-xl', '--fs-lg', '--fs-sm', '--fs-xs', '--fs-2xs']);
const LOCAL = new Set(['--r-panel', '--r-control', '--ease']);
const uncomment = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const squash = (value) => value.replace(/\s+/g, '').toLowerCase();
const declarations = (body) => Object.fromEntries([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(([, name, value]) => [name, squash(value)]));
/** The custom properties of every top-level block whose selector is exactly one of `selectors`, merged in order. */
function blocks(css, selectors) {
  const found = {};
  for (const [, selector, body] of uncomment(css).matchAll(/(?<=^|\})\s*([^{}@]+?)\s*\{([^{}]*)\}/g)) {
    if (selectors.includes(selector.trim())) Object.assign(found, declarations(body));
  }
  return found;
}

test('style.css copies the glass tokens exactly, in both themes', () => {
  const tokens = readFileSync(tokensFile, 'utf8');
  const style = uncomment(readFileSync(path.join(dir, 'style.css'), 'utf8'));
  const light = blocks(tokens, [':root']);
  const darkOnly = blocks(tokens, [":root[data-theme='dark']", ':root[data-theme="dark"]']);
  const dark = { ...light, ...darkOnly };
  const ownLight = blocks(style, [':root']);
  const ownDark = blocks(style, [':root[data-theme="dark"]']);
  assert.ok(Object.keys(ownDark).length > 0, 'style.css has a dark block');
  const source = (name) => (SAME.has(name) ? name : name.replace(/^--/, '--glass-'));
  const copies = Object.keys(ownLight).filter((name) => !LOCAL.has(name));
  assert.ok(copies.length >= 20, `found only ${copies.length} copies`);
  for (const name of copies) {
    assert.equal(ownLight[name], light[source(name)], `${name} (light) differs from tokens.css ${source(name)}`);
    assert.equal(ownDark[name] ?? ownLight[name], dark[source(name)], `${name} (dark) differs from tokens.css ${source(name)}`);
  }
  for (const name of Object.keys(ownDark)) assert.ok(name in ownLight, `${name} is set only in the dark block`);
  // Paint comes from the copies: no literal colour outside the token blocks.
  const rules = style.slice(style.indexOf(':root[data-theme="dark"]')).replace(/^[^}]*\}/, '');
  assert.deepEqual(rules.match(/#[0-9a-f]{3,8}\b|rgba?\(/gi) ?? [], []);
  // Every page takes the theme before it paints (theme.js, src/theme.ts).
  for (const page of readdirSync(dir).filter((name) => name.endsWith('.html'))) {
    const head = readFileSync(path.join(dir, page), 'utf8').split('<body')[0];
    assert.match(head, /<script src="theme\.js"><\/script>/, `${page} loads theme.js in its head`);
  }
});
