/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { PROJECT_ACCENT_SLOTS } from './projectIdentity';

const tokensCss = readFileSync(resolve(__dirname, 'tokens.css'), 'utf8');

it('tokens.css was actually read', () => {
  // Guards against a transform silently emptying the file, which would
  // make every assertion below pass without testing anything.
  expect(tokensCss.length).toBeGreaterThan(500);
});

function parseBlock(selector: string): Record<string, string> {
  const start = tokensCss.indexOf(selector);
  if (start === -1) throw new Error(`missing block: ${selector}`);
  const open = tokensCss.indexOf('{', start);
  const close = tokensCss.indexOf('}', open);
  const out: Record<string, string> = {};
  for (const line of tokensCss.slice(open + 1, close).split('\n')) {
    const m = line.match(/^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const ch = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const f = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(ch[0]) + 0.7152 * f(ch[1]) + 0.0722 * f(ch[2]);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const BACKGROUNDS = ['--surface', '--bg', '--surface-3'] as const;
const TEXTS = ['--text', '--text-2', '--text-3', '--accent'] as const;
const CHIPS: [string, string][] = [
  ['--accent', '--accent-soft'],
  ['--ok', '--ok-soft'],
  ['--warn', '--warn-soft'],
  ['--danger', '--danger-soft'],
];

// -on labels sit on top of their matching solid fill (e.g. button text on a
// filled button); -hover is the darker/lighter state of that same fill and
// must stay legible against the -on label that sits on top of it in both
// states.
const ON_LABELS: [string, string][] = [
  ['--accent-on', '--accent'],
  ['--ok-on', '--ok'],
  ['--warn-on', '--warn'],
  ['--danger-on', '--danger'],
];

// Kept in lockstep with PROJECT_ACCENT_SLOTS in projectIdentity.ts: the
// mapper hashes into exactly this many slots, so a slot it can emit that
// tokens.css never declares would render a transparent dot.
const PROJECT_SLOTS = Array.from(
  { length: PROJECT_ACCENT_SLOTS },
  (_, i) => `--proj-${i + 1}`,
);

const HOVER_ON_LABELS: [string, string][] = [
  ['--accent-hover', '--accent-on'],
  ['--ok-hover', '--ok-on'],
  ['--warn-hover', '--warn-on'],
  ['--danger-hover', '--danger-on'],
];

describe.each([
  ['light', ':root {'],
  ['dark', ':root[data-theme="dark"] {'],
])('%s theme contrast', (_name, selector) => {
  const t = parseBlock(selector);

  it.each(
    TEXTS.flatMap((fg) => BACKGROUNDS.map((bg) => [fg, bg] as const)),
  )('%s on %s meets AA 4.5:1', (fg, bg) => {
    expect(contrast(t[fg], t[bg])).toBeGreaterThanOrEqual(4.5);
  });

  it.each(CHIPS)('%s on %s meets AA 4.5:1', (fg, bg) => {
    expect(contrast(t[fg], t[bg])).toBeGreaterThanOrEqual(4.5);
  });

  it.each(BACKGROUNDS)('--border-interactive on %s meets 3:1', (bg) => {
    expect(contrast(t['--border-interactive'], t[bg])).toBeGreaterThanOrEqual(3);
  });

  it('primary button label is readable on the accent fill', () => {
    expect(contrast(t['--accent-on'], t['--accent'])).toBeGreaterThanOrEqual(4.5);
  });

  it.each(ON_LABELS)('%s label is readable on its %s fill', (onVar, fillVar) => {
    expect(contrast(t[onVar], t[fillVar])).toBeGreaterThanOrEqual(4.5);
  });

  it.each(HOVER_ON_LABELS)('%s stays readable against its %s label colour', (hoverVar, onVar) => {
    expect(contrast(t[hoverVar], t[onVar])).toBeGreaterThanOrEqual(4.5);
  });

  // Project dots are 10px graphical identity cues, not text, so the bar is
  // the WCAG non-text-contrast 3:1 rather than 4.5:1. They render on the rail
  // (--surface-2) and on a selected/hovered row (--surface-3).
  it.each(
    PROJECT_SLOTS.flatMap((slot) =>
      (['--surface-2', '--surface-3'] as const).map((bg) => [slot, bg] as const),
    ),
  )('%s dot on %s meets non-text 3:1', (slot, bg) => {
    expect(contrast(t[slot], t[bg])).toBeGreaterThanOrEqual(3);
  });

  it('declares every project slot the mapper can produce', () => {
    for (const slot of PROJECT_SLOTS) {
      expect(t[slot], `${slot} missing from ${_name} theme`).toBeTruthy();
    }
  });
});

// --scrim is a theme-invariant translucent overlay (rgb() with alpha), so it
// can't go through the hex-only contrast() helper above — just assert it
// exists once and isn't redeclared per theme.
describe('scrim token', () => {
  it('is defined in :root', () => {
    const light = parseBlock(':root {');
    expect(light['--scrim']).toBeDefined();
  });

  it('is absent from the dark theme override (stays theme-invariant)', () => {
    const dark = parseBlock(':root[data-theme="dark"] {');
    expect(dark['--scrim']).toBeUndefined();
  });
});

// The terminal bezel is theme-invariant (always dark, regardless of app
// theme), so it has exactly one set of values — no light/dark split to loop
// over. This region previously had zero contrast guard, which is why the
// semantic/luminance-bucketing bug that broke it went undetected.
describe('terminal chrome contrast (theme-invariant)', () => {
  const t = parseBlock(':root {');

  const TERM_PAIRS: [string, string][] = [
    ['--term-text', '--term-surface'],
    ['--term-text', '--term-bg'],
    ['--term-muted', '--term-surface'],
    ['--term-live-text', '--term-live-bg'],
    ['--term-error-text', '--term-error-bg'],
    ['--term-idle-text', '--term-idle-bg'],
    ['--term-warn-text', '--term-surface'],
    ['--term-warn-text', '--term-bg'],
    ['--term-warn-text', '--term-warn-bg'],
    // Downloadable paths in the select-mode copy layer, at rest and on hover.
    ['--term-link', '--term-bg'],
    ['--term-link', '--term-hover'],
  ];

  it.each(TERM_PAIRS)('%s on %s meets AA 4.5:1', (fg, bg) => {
    expect(contrast(t[fg], t[bg])).toBeGreaterThanOrEqual(4.5);
  });

  it('is absent from the dark theme override (stays theme-invariant)', () => {
    const dark = parseBlock(':root[data-theme="dark"] {');
    for (const key of Object.keys(t)) {
      if (key.startsWith('--term-')) {
        expect(dark[key]).toBeUndefined();
      }
    }
  });
});

/* Glass small text (≤12px) is WCAG AA text, so 4.5:1, on every glass surface
   it sits on. The surfaces are translucent, so each is composited over what is
   under it: the panel over the backdrop, then the sheen, a selected row and a
   bubble over the panel. */
describe('glass small text contrast', () => {
  const glassStart = tokensCss.indexOf('/* Dolphin glass workspace');
  function blockAt(index: number): Record<string, string> {
    if (index < 0) throw new Error('missing glass token block');
    const open = tokensCss.indexOf('{', index);
    const close = tokensCss.indexOf('}', open);
    const out: Record<string, string> = {};
    for (const line of tokensCss.slice(open + 1, close).split('\n')) {
      const m = line.match(/^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/);
      if (m) out[m[1]] = m[2].trim();
    }
    return out;
  }
  const light = blockAt(tokensCss.indexOf(':root {', glassStart));
  const dark = { ...light, ...blockAt(tokensCss.indexOf(":root[data-theme='dark'] {", glassStart)) };
  function over(top: string, under: string): string {
    const m = top.match(/rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)/);
    if (!m) throw new Error(`not an rgba(): ${top}`);
    const base = under.replace('#', '');
    return '#' + [1, 2, 3].map((i, k) => {
      const value = Number(m[4]) * Number(m[i]) + (1 - Number(m[4])) * parseInt(base.slice(k * 2, k * 2 + 2), 16);
      return Math.round(value).toString(16).padStart(2, '0');
    }).join('');
  }
  function surfaces(tokens: Record<string, string>) {
    const panel = over(tokens['--glass-panel'], tokens['--glass-bg']);
    return { backdrop: tokens['--glass-bg'], panel, sheen: over(tokens['--glass-sheen'], panel), selected: over(tokens['--glass-selection'], panel), bubble: over(tokens['--glass-bubble'], panel) };
  }

  it.each([['light', light], ['dark', dark]] as const)('%s: --glass-muted-small reads at 4.5:1 or better on every glass surface', (theme, tokens) => {
    const small = tokens['--glass-muted-small'];
    expect(small, `${theme} --glass-muted-small`).toMatch(/^#[0-9a-f]{6}$/i);
    for (const [name, surface] of Object.entries(surfaces(tokens))) {
      expect(contrast(small, surface), `${theme} on ${name} ${surface}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('documents why: light --glass-muted is under 4.5:1 on the panel', () => {
    expect(contrast(light['--glass-muted'], surfaces(light).panel)).toBeLessThan(4.5);
  });
});
