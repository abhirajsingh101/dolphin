import { describe, expect, it } from 'vitest';
import { branchProblem } from './branchName';

describe('branchProblem', () => {
  it('accepts ordinary branch names', () => {
    for (const name of ['dolphin/try', 'feature-1', 'fix_bug.2', 'a/b/c']) expect(branchProblem(name)).toBeNull();
  });

  it('says plainly what is wrong', () => {
    expect(branchProblem('')).toBe('Give the branch a name.');
    expect(branchProblem('   ')).toBe('Give the branch a name.');
    expect(branchProblem('my branch')).toBe('A branch name cannot contain spaces.');
    expect(branchProblem('-x')).toBe('A branch name cannot start with a dash.');
    expect(branchProblem('/x')).toBe('A branch name cannot start or end with a slash.');
    expect(branchProblem('x/')).toBe('A branch name cannot start or end with a slash.');
    expect(branchProblem('a//b')).toBe('A branch name cannot have an empty part between slashes.');
    expect(branchProblem('a..b')).toBe('A branch name cannot contain "..".');
    expect(branchProblem('a.lock')).toBe('A branch name cannot end in ".lock" or ".".');
    expect(branchProblem('a.')).toBe('A branch name cannot end in ".lock" or ".".');
    expect(branchProblem('a~b')).toBe('A branch name cannot contain ~ ^ : ? * [ \\ or @{.');
    expect(branchProblem('a@{b')).toBe('A branch name cannot contain ~ ^ : ? * [ \\ or @{.');
    expect(branchProblem('@')).toBe('A branch name cannot be just "@".');
  });
});
