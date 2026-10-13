import { describe, expect, it } from 'vitest';
import { elapsed, nextRow, projectSummary, rowTime, visibleProjects } from './sidebarModel';

const project = (id: string, sessions: number, is_inbox = false) => ({ id, is_inbox, sessions: Array.from({ length: sessions }, () => ({})) });

describe('visibleProjects', () => {
  const projects = [project('inbox', 0, true), project('atlas', 2), project('nova', 0), project('slate', 0), project('box', 1, true)];
  it('shows projects with sessions, hides the empty Inbox, and counts the empty rest', () => {
    const { shown, hiddenEmpty } = visibleProjects(projects, { revealed: new Set(), showEmpty: false, filtering: false });
    expect(shown.map((p) => p.id)).toEqual(['atlas', 'box']);
    expect(hiddenEmpty).toBe(2);
  });
  it('shows a project linked in this window, and every empty one on request or while filtering', () => {
    expect(visibleProjects(projects, { revealed: new Set(['nova']), showEmpty: false, filtering: false }).shown.map((p) => p.id)).toEqual(['atlas', 'nova', 'box']);
    expect(visibleProjects(projects, { revealed: new Set(), showEmpty: true, filtering: false })).toEqual({ shown: [projects[1], projects[2], projects[3], projects[4]], hiddenEmpty: 0 });
    expect(visibleProjects(projects, { revealed: new Set(), showEmpty: false, filtering: true }).hiddenEmpty).toBe(0);
  });
});

describe('projectSummary', () => {
  it('says what is going on, idle sessions left out', () => {
    expect(projectSummary(['working', 'unread', 'working', 'idle', 'error'])).toBe('2 working · 1 unread · 1 error');
  });
  it('falls back to the session count', () => {
    expect(projectSummary(['idle', 'idle'])).toBe('2 sessions');
    expect(projectSummary(['idle'])).toBe('1 session');
    expect(projectSummary([])).toBe('0 sessions');
  });
});

describe('elapsed', () => {
  const now = Date.parse('2026-10-12T12:00:00Z');
  it('is short and tabular', () => {
    expect(elapsed('2026-10-12T11:59:30Z', now)).toBe('now');
    expect(elapsed('2026-10-12T11:57:00Z', now)).toBe('3m');
    expect(elapsed('2026-10-12T09:00:00Z', now)).toBe('3h');
    expect(elapsed('2026-10-09T12:00:00Z', now)).toBe('3d');
  });
  it('says nothing without a time, and nothing negative', () => {
    expect(elapsed(null, now)).toBe('');
    expect(elapsed('soon', now)).toBe('');
    expect(elapsed('2026-10-12T12:05:00Z', now)).toBe('now');
  });
  it('times a row from its turn, else from its last output', () => {
    expect(rowTime({ turn_at: 'a', last_activity_at: 'b' })).toBe('a');
    expect(rowTime({ turn_at: null, last_activity_at: 'b' })).toBe('b');
  });
});

describe('nextRow', () => {
  it('moves one row and stops at the ends', () => {
    expect(nextRow(3, 0, 1)).toBe(1);
    expect(nextRow(3, 2, 1)).toBe(2);
    expect(nextRow(3, 0, -1)).toBe(0);
    expect(nextRow(3, -1, 1)).toBe(0);
    expect(nextRow(3, -1, -1)).toBe(2);
    expect(nextRow(0, 0, 1)).toBe(-1);
  });
});
