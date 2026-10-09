import { describe, expect, it } from 'vitest';

/// <reference types="node" />
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Read from disk, NOT via `import './styles.css?raw'`. Vitest's default
// css: false turns every .css?raw import into an empty string, and an empty
// string makes every assertion below pass while testing nothing.
function readSheet(name: string): string {
  const css = readFileSync(resolve(__dirname, name), 'utf8');
  if (css.trim().length < 100) {
    throw new Error(`${name} read as empty — this guard would pass vacuously`);
  }
  return css;
}

// Every stylesheet the app ships, found on disk so a new sheet cannot be
// missed. tokens.css is where the literal values live, so it is the exception.
// The two sheets below predate this discovery, were never on the old hand-kept
// list, and break the type and radius scales; they stay unchecked until fixed.
const NOT_YET_CHECKED = new Set(['tokens.css', 'improvementRadar.css', 'taskQuality.css']);
const SHEETS: [string, string][] = (readdirSync(__dirname, { recursive: true }) as string[])
  .filter((name) => name.endsWith('.css') && !NOT_YET_CHECKED.has(name))
  .sort()
  .map((name) => [name, readSheet(name)]);
if (SHEETS.length < 5) throw new Error(`found only ${SHEETS.length} stylesheets — this guard would pass vacuously`);

const ALLOWED_RADII = ['var(--r-sm)', 'var(--r-md)', 'var(--r-lg)', 'var(--r-xl)', 'var(--r-full)', '50%', '0', '1px', '2px'];

// The glass workspace's approved motion (docs/design-contract.md, "Dolphin
// glass workspace motion (2026-09-21)"): brief window and message entry, and a
// bounded panel-size transition, on #/workspace only. It is exempt from the two
// motion guards below and nothing else is; in exchange the sheet must switch
// all of it off under prefers-reduced-motion, which the last guard checks.
const MOTION_EXCEPTIONS = new Set(['glass.css']);

// CSS named colors ("white", "black", …) are literal color values that dodge
// both the hex guard and the rgb()/rgba() guard above — this is exactly how
// nine `color: white` declarations shipped invisible-on-invisible in dark
// mode (white text on a var(--text) fill, which IS white/near-white in dark
// theme) without tripping any existing check. Only properties that actually
// carry paint are checked, so this does not flag `white-space`, class names
// like `.research-pill.green`, or keywords such as `currentColor`/
// `transparent`/`inherit`/`none` (deliberately excluded from the list).
const NAMED_COLORS = [
  'white', 'black', 'red', 'blue', 'green', 'yellow', 'orange', 'purple',
  'pink', 'cyan', 'magenta', 'brown', 'gray', 'grey', 'navy', 'teal',
  'lime', 'maroon', 'olive', 'silver', 'gold', 'indigo', 'violet',
  'salmon', 'coral', 'khaki', 'crimson', 'turquoise', 'beige', 'ivory',
  'lavender', 'plum', 'orchid', 'tan', 'wheat', 'chocolate', 'sienna',
  'peru', 'aquamarine', 'azure',
];
const COLOR_BEARING_PROPS =
  '(?:color|background|background-color|border(?:-top|-right|-bottom|-left)?(?:-color)?|outline(?:-color)?|box-shadow|fill|stroke|caret-color|text-decoration-color)';
const NAMED_COLOR_PATTERN = new RegExp(`\\b(${NAMED_COLORS.join('|')})\\b`, 'i');

describe.each(SHEETS)('%s', (_name, css) => {
  it('declares no raw hex colours', () => {
    expect(css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
  });

  it('declares no legacy indigo token names', () => {
    expect(css).not.toMatch(/--(ak|cc)-(accent|bg|surface|text|muted|border)/);
  });

  // Each value of a (possibly per-corner) radius must be a step of the scale.
  // This compared substrings until 2026-09-24, so "12px" passed for containing
  // "2px", and "10px" and "22px" for containing "0" and "2px".
  it('uses only the closed radius scale', () => {
    const offenders: string[] = [];
    for (const match of css.matchAll(/border-radius:\s*([^;]+);/g)) {
      const values = match[1].trim().split(/\s+(?![^(]*\))/);
      if (!values.every((value) => ALLOWED_RADII.includes(value))) offenders.push(match[0]);
    }
    expect(offenders).toEqual([]);
  });

  // --fs-2xs (11px) is the smallest step the type scale defines, but the
  // sheets had drifted well below it: 91 declarations at 10px, 9px and 8px,
  // including table headers, GPU metric labels and process PIDs. 8px is
  // smaller than any platform's readable minimum, and none of it was
  // expressible in the token system — the scale simply stopped being used at
  // the bottom end. Pixel font sizes are allowed above the floor so existing
  // 12px/13px values are not forced through this gate; only sizes that
  // undercut the scale's own smallest step fail.
  it('declares no font-size below the smallest step in the type scale', () => {
    const offenders: string[] = [];
    const pattern = /font-size:\s*(\d+(?:\.\d+)?)px/g;
    for (const match of css.matchAll(pattern)) {
      if (Number.parseFloat(match[1]) < 11) offenders.push(match[0]);
    }
    expect(offenders).toEqual([]);
  });

  it('declares no rgba()/rgb() colour other than pure black or pure white', () => {
    // Any other triple is a raw colour literal hiding from the hex guard —
    // exactly how the legacy cool-slate (17, 24, 39) and rust (188, 79, 66)
    // survived a "zero raw hex" sheet. Only theme-neutral black/white scrims
    // are allowed to bypass the token system.
    //
    // Matches both legacy comma syntax — rgba(17, 24, 39, 0.5) — and modern
    // CSS Color 4 space/slash syntax — rgb(17 24 39 / 50%) — so a value
    // written in the newer form can't quietly dodge this guard.
    const offenders: string[] = [];
    const pattern = /rgba?\(\s*(\d+)(?:\s*,\s*|\s+)(\d+)(?:\s*,\s*|\s+)(\d+)/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(css))) {
      const [, r, g, b] = match;
      const isNeutral =
        (r === '0' && g === '0' && b === '0') ||
        (r === '255' && g === '255' && b === '255');
      if (!isNeutral) {
        offenders.push(`rgb(${r}, ${g}, ${b})`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('declares no CSS named colors in color/background/border declarations', () => {
    const declPattern = new RegExp(`\\b${COLOR_BEARING_PROPS}\\s*:\\s*([^;{}]+);`, 'g');
    const offenders: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = declPattern.exec(css))) {
      if (NAMED_COLOR_PATTERN.test(match[0])) {
        offenders.push(match[0].trim());
      }
    }
    expect(offenders).toEqual([]);
  });
});

// ES modules evaluate each import statement's module — and everything IT
// transitively imports — to completion, in declaration order. main.tsx used
// to import App (which pulls in commandPalette.css and kanban.css through
// its own component tree) BEFORE its own tokens.css/components.css/
// styles.css imports, so those three sheets silently loaded dead last,
// letting components.css win every same-specificity tie against kanban.css
// and commandPalette.css (confirmed by diffing byte offsets in the built
// bundle: cp-panel/ak-column-body landed before components.css's dt-btn).
// These two source-order checks are the static equivalent of that bundle
// diff — cheap to run on every commit, and they fail the moment either
// import is reordered again, without needing a build step first.
describe('stylesheet load order', () => {
  // The web app's entry (main.tsx) and Dolphin Desktop's (desktop/main.tsx);
  // the public repository has only the second.
  const ENTRIES = ['main.tsx', 'desktop/main.tsx'].filter((file) => existsSync(resolve(__dirname, file)));

  it.each(ENTRIES)('%s imports the shared style entry point before any component', (file) => {
    const entry = readFileSync(resolve(__dirname, file), 'utf8');
    const styleImportIndex = entry.search(/import\s+['"]\.{1,2}\/styles['"]/);
    const componentImportIndex = entry.search(/import\s+\w+\s+from\s+['"]\.{1,2}\/[A-Z]/);
    expect(styleImportIndex).toBeGreaterThan(-1);
    expect(componentImportIndex).toBeGreaterThan(-1);
    expect(styleImportIndex).toBeLessThan(componentImportIndex);
  });

  it('checks at least one entry point', () => {
    expect(ENTRIES.length).toBeGreaterThan(0);
  });

  it('the style entry point loads tokens, then components, then styles', () => {
    const entry = readFileSync(resolve(__dirname, 'styles', 'index.ts'), 'utf8');
    const tokensIndex = entry.indexOf("'../tokens.css'");
    const componentsIndex = entry.indexOf("'../components.css'");
    const stylesIndex = entry.indexOf("'../styles.css'");
    expect(tokensIndex).toBeGreaterThan(-1);
    expect(componentsIndex).toBeGreaterThan(tokensIndex);
    expect(stylesIndex).toBeGreaterThan(componentsIndex);
  });
});

// ---------------------------------------------------------------------------
// Focus visibility (Vercel web-interface-guidelines: "never outline-none
// without a focus replacement").
//
// Three keyboard-reachable controls — the panel resize handles, the inline
// task textarea, and the harness search field — removed the native outline and
// put nothing back, so tabbing through them landed on an invisible target.
// This guard fails if a rule strips the outline and no matching :focus or
// :focus-visible rule restores a visible indicator for that same selector.
// ---------------------------------------------------------------------------

/** Selectors whose rule body sets `outline: none` (or `outline: 0`). */
function selectorsKillingOutline(css: string): string[] {
  const found: string[] = [];
  // Match `<selector> { ... outline: none ... }`. Non-greedy body so nested
  // at-rules do not swallow neighbouring blocks.
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = ruleRe.exec(css)) !== null) {
    const [, rawSelector, body] = match;
    if (!/outline:\s*(none|0)\s*[;}]/.test(body)) continue;
    for (const part of rawSelector.split(',')) {
      const selector = part.trim();
      // Skip at-rule preludes (@media …) — they carry no declarations.
      if (!selector || selector.startsWith('@')) continue;
      found.push(selector);
    }
  }
  return found;
}

describe('focus visibility', () => {
  it('never removes an outline without restoring a visible focus indicator', () => {
    const offenders: string[] = [];

    for (const [name, css] of SHEETS) {
      for (const selector of selectorsKillingOutline(css)) {
        // A rule that removes the outline *inside* a focus state is itself the
        // replacement (it swaps outline for a background or ring).
        if (/:focus(-visible|-within)?\b/.test(selector)) continue;

        // A focus rule on the element itself OR on any ancestor in its
        // selector counts. `.ak-search input { outline: none }` paired with
        // `.ak-search:focus-within { … }` is the compound-control pattern the
        // guidelines explicitly endorse — checking only the leaf would flag
        // three correct search fields and get this guard switched off.
        const base = selector.replace(/::?[a-z-]+(\([^)]*\))?$/i, '').trim();
        if (!base) continue;

        // Check progressive PREFIXES of the selector, not its individual
        // components. `.task-row textarea` must be covered by
        // `.task-row:focus…` or `.task-row textarea:focus…` — matching the
        // bare component `textarea:focus` would let an unrelated
        // `.link-form input:focus` rule vouch for every `input` in the app,
        // which is how the first version of this guard passed vacuously.
        const parts = base.split(/\s*([>+~])\s*|\s+/).filter(Boolean);
        const prefixes: string[] = [];
        for (let index = 0; index < parts.length; index += 1) {
          const prefix = parts.slice(0, index + 1).join(' ').trim();
          if (prefix && !'>+~'.includes(prefix.slice(-1))) prefixes.push(prefix);
        }
        const covered = prefixes.some((prefix) => {
          const escaped = prefix
            .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            .replace(/\s+/g, '\\s+');
          return new RegExp(`${escaped}\\s*:focus(-visible|-within)?\\b`).test(css);
        });
        if (!covered) offenders.push(`${name}: ${selector}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe('typography details', () => {
  it('uses the ellipsis character, not three periods, in shipped copy', () => {
    // "Loading..." vs "Loading…" — the guidelines call for the real character,
    // and mixing the two looked sloppy across loading states.
    // Terminal UI copy is owned and checked by @dolphin-terminal/react.
    const sources = (readdirSync(__dirname, { recursive: true }) as string[]).filter((name) => name.endsWith('.tsx'));
    const offenders: string[] = [];
    for (const file of sources) {
      const source = readFileSync(resolve(__dirname, file), 'utf8');
      source.split('\n').forEach((line, index) => {
        // Only user-visible strings: literal ... immediately before a closing
        // quote or JSX tag. Ignores spread syntax and comments.
        if (/\.\.\.(?=["'`<])/.test(line)) {
          offenders.push(`${file}:${index + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});

/* MOTION_INTENSITY 3 (docs/design-contract.md §2): motion confirms state
   changes and nothing else — no entrance animations, and every transition
   between 120ms and 200ms.

   The board shipped an `ak-enter` staggered fade-and-rise on every card for
   exactly as long as the dial forbidding it existed, because nothing checked.
   These two guards are the check. */
describe('motion contract', () => {
  // Comments discuss the rules they enforce — the duration guard below failed
  // on the very comment recording that --d3 had been deleted. Strip them, or
  // the prose becomes the code.
  const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

  // Infinite loops are the deliberate exception: spinners and the "still
  // waiting" pulses are status, not decoration, and they have no entrance.
  const LOOPING = /\binfinite\b/;

  it('declares no entrance animations', () => {
    const offenders: string[] = [];
    for (const [name, css] of SHEETS) {
      if (MOTION_EXCEPTIONS.has(name)) continue;
      stripComments(css)
        .split('\n')
        .forEach((line, index) => {
          const match = line.match(/animation(?:-name)?\s*:\s*([^;]+);/);
          if (!match) return;
          const value = match[1].trim();
          if (LOOPING.test(value) || value === 'none') return;
          offenders.push(`${name}:${index + 1}: ${line.trim()}`);
        });
    }
    expect(offenders).toEqual([]);
  });

  /* The dial forbids animating anything that triggers layout. It used to say
     "transform/opacity only", which 25 of 32 declarations broke by animating
     colour — while none of the 32 ever caused a reflow. §2 now states the rule
     that was always meant, and this is what holds it. */
  it('transitions no property that triggers layout', () => {
    const LAYOUT_TRIGGERING =
      /^(?:width|height|min-width|min-height|max-width|max-height|margin|padding|top|right|bottom|left|inset|font-size|line-height|flex|flex-basis|grid|grid-template-columns|grid-template-rows|border-width|gap|all)$/;
    const offenders: string[] = [];
    for (const [name, css] of SHEETS) {
      if (MOTION_EXCEPTIONS.has(name)) continue;
      stripComments(css)
        .split('\n')
        .forEach((line, index) => {
          const match = line.match(/transition(?:-property)?\s*:\s*([^;]+);?/);
          if (!match) return;
          for (const part of match[1].split(',')) {
            const property = part.trim().split(/\s+/)[0];
            if (!property || !LAYOUT_TRIGGERING.test(property)) continue;
            offenders.push(`${name}:${index + 1}: ${property}`);
          }
        });
    }
    expect(offenders).toEqual([]);
  });

  it('turns every excepted animation off under prefers-reduced-motion', () => {
    for (const [name, css] of SHEETS) {
      if (!MOTION_EXCEPTIONS.has(name)) continue;
      const reduced = [...stripComments(css).matchAll(/@media[^{]*prefers-reduced-motion:\s*reduce[^{]*\{([\s\S]*?)\n\}/g)]
        .map((block) => block[1]).join('\n');
      expect(reduced, `${name} has no reduced-motion block`).toMatch(/animation:\s*none/);
      expect(reduced, `${name} leaves transitions on under reduced motion`).toMatch(/transition:\s*none/);
    }
  });

  it('exposes no duration token outside the 120-200ms band', () => {
    const offenders: string[] = [];
    for (const match of stripComments(readSheet('tokens.css')).matchAll(
      /(--d\d+)\s*:\s*(\d+)ms/g,
    )) {
      const value = Number(match[2]);
      // 0ms is the prefers-reduced-motion override, which is the point.
      if (value === 0 || (value >= 120 && value <= 200)) continue;
      offenders.push(`${match[1]}: ${value}ms`);
    }
    expect(offenders).toEqual([]);
  });
});
