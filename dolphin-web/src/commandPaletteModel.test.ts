import { describe, expect, it } from 'vitest';

import {
  moveSelection,
  scoreItem,
  searchPalette,
  type PaletteItem,
} from './commandPaletteModel';

const items: PaletteItem[] = [
  { id: 'a1', kind: 'action', label: 'Open serial queue' },
  { id: 't1', kind: 'task', label: 'Self-host Geist', hint: 'Todo' },
  { id: 't2', kind: 'task', label: 'Benchmark Netdata polling', hint: 'In progress' },
  { id: 'p1', kind: 'project', label: 'research-notes' },
  { id: 's1', kind: 'session', label: 't2:claude', hint: 'robot-sim' },
];

describe('scoreItem', () => {
  it('scores a prefix match above a substring match', () => {
    const prefix = scoreItem({ id: 'x', kind: 'task', label: 'research plan' }, 'res');
    const substring = scoreItem({ id: 'y', kind: 'task', label: 'my research' }, 'res');
    expect(prefix).toBeGreaterThan(substring);
  });

  it('is case insensitive', () => {
    expect(scoreItem(items[1], 'GEIST')).toBeGreaterThan(0);
  });

  it('returns zero when the query does not appear', () => {
    expect(scoreItem(items[1], 'zzz')).toBe(0);
  });

  it('matches against the hint as well as the label', () => {
    expect(scoreItem(items[4], 'robot')).toBeGreaterThan(0);
  });
});

describe('searchPalette', () => {
  it('returns every item grouped when the query is empty', () => {
    const groups = searchPalette(items, '');
    expect(groups.flatMap((group) => group.items)).toHaveLength(5);
  });

  it('orders groups actions, tasks, projects, sessions', () => {
    expect(searchPalette(items, '').map((group) => group.kind)).toEqual([
      'action',
      'task',
      'project',
      'session',
    ]);
  });

  it('drops groups that have no match', () => {
    expect(searchPalette(items, 'netdata').map((group) => group.kind)).toEqual(['task']);
  });

  it('honours the limit across all groups', () => {
    const total = searchPalette(items, '', 2).flatMap((group) => group.items);
    expect(total).toHaveLength(2);
  });
});

describe('moveSelection', () => {
  it('wraps forward past the end', () => {
    expect(moveSelection(3, 2, 1)).toBe(0);
  });

  it('wraps backward past the start', () => {
    expect(moveSelection(3, 0, -1)).toBe(2);
  });

  it('stays at zero when there is nothing to select', () => {
    expect(moveSelection(0, 0, 1)).toBe(0);
  });
});
