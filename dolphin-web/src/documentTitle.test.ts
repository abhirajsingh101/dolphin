import { describe, expect, it } from 'vitest';

/// <reference types="node" />
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { APP_TITLE, documentTitleFor, glassDocumentTitle } from './documentTitle';

describe('project routes', () => {
  it('leads with the project name so it survives tab truncation', () => {
    expect(
      documentTitleFor({
        view: 'project',
        projectName: 'brain',
      }),
    ).toBe('brain — Dolphin Tasks');
  });

  it('leads cockpit tabs with the active session so parallel work stays distinct', () => {
    expect(
      documentTitleFor({
        view: 'project',
        projectName: 'brain',
        sessionName: 'training-review',
      }),
    ).toBe('training-review · brain — Dolphin Tasks');
  });

  /* The project list arrives asynchronously, so the name can legitimately be
     missing for a moment on a cold load. Falling back to the bare app title —
     the exact string index.html ships — means that moment is invisible rather
     than a flash of something else. */
  it('falls back to the bare app title while the name is unknown', () => {
    expect(
      documentTitleFor({
        view: 'project',
        projectName: null,
      }),
    ).toBe(APP_TITLE);
  });

  it('does not mangle a name that already contains the separator', () => {
    expect(
      documentTitleFor({
        view: 'project',
        projectName: 'a — b',
      }),
    ).toBe('a — b — Dolphin Tasks');
  });
});

describe('the other routes', () => {
  const cases: ReadonlyArray<[Parameters<typeof documentTitleFor>[0]['view'], string]> = [
    ['control-center', 'Control Center — Dolphin Tasks'],
    ['health', 'System Health — Dolphin Tasks'],
    ['improvement-radar', 'Morning Radar — Dolphin Tasks'],
  ];

  for (const [view, expected] of cases) {
    it(`titles ${view}`, () => {
      expect(
        documentTitleFor({ view, projectName: null }),
      ).toBe(expected);
    });
  }

  /* Every reachable view must produce a stable, app-qualified title. */
  it('gives every view a title, none of them the bare app title', () => {
    for (const [view] of cases) {
      const title = documentTitleFor({
        view,
        projectName: null,
      });
      expect(title).not.toBe(APP_TITLE);
      expect(title.endsWith(APP_TITLE)).toBe(true);
    }
  });

  it('ignores the project name on views that are not a project', () => {
    expect(
      documentTitleFor({
        view: 'control-center',
        projectName: 'brain',
      }),
    ).toBe('Control Center — Dolphin Tasks');
  });
});

/* One writer, enforced against the source rather than against behaviour.
   SystemHealthView used to assign document.title itself, and no behavioural
   test could see it: React flushes child effects before parent ones, so
   App.tsx's assignment always landed last and the duplicate stayed invisible.
   It was still a live hazard — the health view's effect re-runs whenever its
   polling callbacks change identity, and that re-run would overwrite the tab
   title long after App had settled it, with nothing to catch the regression.

   A restored duplicate passes all six e2e title tests. It fails this one. */
describe('route-root writers', () => {
  const SOURCE_DIR = resolve(__dirname);
  const ASSIGNMENT = /(^|[^.\w])document\s*\.\s*title\s*=[^=]/;
  // The public export ships the desktop workspace without the web app's App.tsx.
  // GlassHealthPage is the web app's #/health, which main.tsx renders instead
  // of App or the workspace, never beside them.
  const ROUTE_ROOTS = ['App.tsx', 'GlassHealthPage.tsx', 'GlassWorkspace.tsx'].filter((name) =>
    existsSync(resolve(SOURCE_DIR, name)),
  );

  function sourceFiles(): string[] {
    return readdirSync(SOURCE_DIR)
      .filter((name) => /\.tsx?$/.test(name))
      .filter((name) => !name.endsWith('.test.ts') && !name.endsWith('.test.tsx'));
  }

  it('finds the app source, so this guard cannot pass vacuously', () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(20);
    expect(files).toContain('GlassWorkspace.tsx');
    expect(files).toContain('SystemHealthView.tsx');
  });

  it('only mutually exclusive route roots assign document.title', () => {
    const writers = sourceFiles().filter((name) =>
      ASSIGNMENT.test(readFileSync(resolve(SOURCE_DIR, name), 'utf8')),
    );

    expect(writers).toEqual(ROUTE_ROOTS);
  });
});

describe('glass workspace titles', () => {
  const active = { projectName: 'Atlas', sessionName: 'build' };

  it('names the active session, led by what its program says it is doing', () => {
    expect(glassDocumentTitle(null)).toBe('Dolphin — Workspace');
    expect(glassDocumentTitle(active)).toBe('build · Atlas — Dolphin');
    expect(glassDocumentTitle(active, 'Fixing tests')).toBe('Fixing tests · build · Atlas — Dolphin');
    expect(glassDocumentTitle(active, 'build')).toBe('build · Atlas — Dolphin');
  });
});
