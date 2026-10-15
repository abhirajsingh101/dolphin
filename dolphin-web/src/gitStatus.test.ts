import { describe, expect, it } from 'vitest';
import { gitBrief, gitSummary, mergeGit } from './gitStatus';
import type { GitStatus } from './types';

const base: GitStatus = { branch: 'main', head: 'abc1234', upstream: 'origin/main', ahead: 0, behind: 0, dirty: 0, conflicted: 0 };

describe('gitSummary', () => {
  it('is null without a repository', () => {
    expect(gitSummary(null)).toBeNull();
    expect(gitSummary(undefined)).toBeNull();
  });
  it('names a clean branch', () => {
    expect(gitSummary(base)).toEqual({ text: 'main', label: 'Branch main, up to date with origin/main' });
  });
  it('counts changes and ahead/behind', () => {
    expect(gitSummary({ ...base, dirty: 3, ahead: 1, behind: 2 })).toEqual({
      text: 'main · 3 · ↑1 ↓2',
      label: 'Branch main, 3 uncommitted changes, 1 ahead and 2 behind origin/main',
    });
  });
  it('says one change, conflicts, no upstream and detached heads plainly', () => {
    expect(gitSummary({ ...base, upstream: null, dirty: 1, conflicted: 1 })?.label)
      .toBe('Branch main, 1 uncommitted change, 1 in conflict, no upstream');
    expect(gitSummary({ ...base, branch: null })).toEqual({ text: 'abc1234', label: 'Detached at abc1234, up to date with origin/main' });
    expect(gitSummary({ ...base, branch: null, head: null, upstream: null })?.text).toBe('no commits');
  });
});

describe('gitBrief', () => {
  const at = (over: Partial<GitStatus>): GitStatus => ({ branch: 'main', head: 'abc1234', upstream: 'origin/main', ahead: 0, behind: 0, dirty: 0, conflicted: 0, ...over });
  it('says nothing for a clean main or master', () => {
    expect(gitBrief(at({}))).toBeNull();
    expect(gitBrief(at({ branch: 'master' }))).toBeNull();
    expect(gitBrief(null)).toBeNull();
  });
  it('names any other branch, then changes and ahead/behind', () => {
    expect(gitBrief(at({ branch: 'fix/timeouts' }))?.text).toBe('fix/timeouts');
    expect(gitBrief(at({ dirty: 4, ahead: 2 }))?.text).toBe('±4 · ↑2');
    expect(gitBrief(at({ branch: 'feat', dirty: 1, behind: 3 }))?.text).toBe('feat · ±1 · ↓3');
    expect(gitBrief(at({ branch: null, head: 'abc1234' }))?.text).toBe('abc1234');
  });
  it('keeps the full facts for the tooltip', () => {
    expect(gitBrief(at({ dirty: 4 }))?.label).toBe(gitSummary(at({ dirty: 4 }))?.label);
  });
});

describe('mergeGit', () => {
  it('keeps the identity of every status that did not change', () => {
    const first = { projects: { a: base, b: { ...base, dirty: 1 } }, sessions: {}, errors: {} };
    const second = mergeGit(first, { projects: { a: { ...base }, b: { ...base, dirty: 2 } }, sessions: {}, errors: {} });
    expect(second.projects.a).toBe(first.projects.a);
    expect(second.projects.b?.dirty).toBe(2);
    expect(mergeGit(first, JSON.parse(JSON.stringify(first)))).toBe(first);
  });
});
