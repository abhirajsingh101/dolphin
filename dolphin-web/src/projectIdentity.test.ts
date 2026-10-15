import { describe, expect, it } from 'vitest';

import {
  PROJECT_ACCENT_SLOTS,
  commonPathPrefix,
  projectAccentVar,
  projectPathLabel,
  relativeProjectPath,
} from './projectIdentity';

describe('commonPathPrefix', () => {
  it('finds the shared workspace root', () => {
    expect(
      commonPathPrefix([
        '/home/me/projects/brain',
        '/home/me/projects/atlas-studio',
        '/home/me/projects/extra/websites',
      ]),
    ).toBe('/home/me/projects');
  });

  it('never consumes the project directory itself', () => {
    expect(
      commonPathPrefix(['/home/me/projects/brain', '/home/me/projects/brain']),
    ).toBe('/home/me/projects');
  });

  it('returns nothing when paths diverge at the root', () => {
    expect(commonPathPrefix(['/home/me/a', '/srv/b'])).toBe('');
  });

  it('returns nothing for a single path', () => {
    expect(commonPathPrefix(['/home/me/projects/brain'])).toBe('');
  });

  it('ignores unlinked and relative paths', () => {
    expect(
      commonPathPrefix([null, 'relative/path', '/home/me/projects/brain']),
    ).toBe('');
  });
});

describe('relativeProjectPath', () => {
  it('strips the prefix', () => {
    expect(relativeProjectPath('/home/me/projects/brain', '/home/me/projects')).toBe(
      'brain',
    );
  });

  it('keeps nested remainders intact', () => {
    expect(
      relativeProjectPath('/home/me/projects/extra/websites', '/home/me/projects'),
    ).toBe('extra/websites');
  });

  it('leaves non-matching paths alone', () => {
    expect(relativeProjectPath('/srv/app', '/home/me/projects')).toBe('/srv/app');
  });

  it('passes through when there is no prefix', () => {
    expect(relativeProjectPath('/srv/app', '')).toBe('/srv/app');
  });

  it('returns null for unlinked projects', () => {
    expect(relativeProjectPath(null, '/home/me/projects')).toBeNull();
  });
});

describe('projectPathLabel', () => {
  it('drops the line when the directory only repeats the name', () => {
    expect(
      projectPathLabel('atlas-studio', '/home/me/projects/atlas-studio', '/home/me/projects'),
    ).toBeNull();
  });

  it('ignores case, spaces, dashes and underscores when comparing', () => {
    expect(
      projectPathLabel('Field Notes App', '/home/me/projects/field-notes-app', '/home/me/projects'),
    ).toBeNull();
    expect(
      projectPathLabel('startup_os', '/home/me/projects/startup-os', '/home/me/projects'),
    ).toBeNull();
  });

  it('keeps the line when the directory adds information', () => {
    expect(
      projectPathLabel('Robot Console', '/home/me/projects/robot-control', '/home/me/projects'),
    ).toBe('robot-control');
  });

  it('returns null for unlinked projects', () => {
    expect(projectPathLabel('Scratch', null, '/home/me/projects')).toBeNull();
  });
});

describe('projectAccentVar', () => {
  it('is stable for the same seed', () => {
    expect(projectAccentVar('abc')).toBe(projectAccentVar('abc'));
  });

  it('only ever resolves to a declared slot', () => {
    const allowed = new Set(
      Array.from({ length: PROJECT_ACCENT_SLOTS }, (_, i) => `var(--proj-${i + 1})`),
    );
    for (const seed of ['a', 'brain', 'atlas-studio', '', '35c834ac252f4da8b45a6dccf20dbf19']) {
      expect(allowed.has(projectAccentVar(seed))).toBe(true);
    }
  });

  it('spreads seeds across more than one slot', () => {
    const seeds = Array.from({ length: 40 }, (_, i) => `project-${i}`);
    expect(new Set(seeds.map(projectAccentVar)).size).toBeGreaterThan(1);
  });

  // Real project ids are 32-char lowercase hex — a 16-character alphabet.
  // A weak mixer over that alphabet left two slots permanently unused and
  // stacked a third of the rail on one colour, which is the exact failure
  // the palette mapping exists to prevent.
  it('uses every slot across realistic 32-char hex ids', () => {
    const ids = Array.from({ length: 300 }, (_, i) =>
      i.toString(16).padStart(32, '0abcdef9134'.repeat(3)).slice(-32),
    );
    const used = new Set(ids.map(projectAccentVar));
    expect(used.size).toBe(PROJECT_ACCENT_SLOTS);
  });

  it('keeps any single slot under half the rail for a typical project count', () => {
    const ids = [
      '01617025451347a98b5fb71e45d93e73',
      'c974690e85a84f94a4a84bf1a708090d',
      '0f05545deb134e9a98a410eb57861e65',
      '35c834ac252f4da8b45a6dccf20dbf19',
      'adaedba4a0e147ee81358df52769688e',
      '735c5147725a4a499974f81fa537a0cd',
    ];
    const counts = new Map<string, number>();
    for (const id of ids) {
      const slot = projectAccentVar(id);
      counts.set(slot, (counts.get(slot) ?? 0) + 1);
    }
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(ids.length / 2);
  });
});
