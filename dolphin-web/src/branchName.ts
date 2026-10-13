/* A client-side check of a new worktree branch, in plain words. The server
   validates again; this only saves a round trip. Returns null when fine. */
export function branchProblem(name: string): string | null {
  const branch = name.trim();
  if (!branch) return 'Give the branch a name.';
  if (branch === '@') return 'A branch name cannot be just "@".';
  if (/\s/.test(branch)) return 'A branch name cannot contain spaces.';
  if (branch.startsWith('-')) return 'A branch name cannot start with a dash.';
  if (branch.startsWith('/') || branch.endsWith('/')) return 'A branch name cannot start or end with a slash.';
  if (branch.includes('//')) return 'A branch name cannot have an empty part between slashes.';
  if (branch.includes('..')) return 'A branch name cannot contain "..".';
  // eslint-disable-next-line no-control-regex
  if (/[~^:?*[\\\x00-\x1f\x7f]/.test(branch) || branch.includes('@{')) return 'A branch name cannot contain ~ ^ : ? * [ \\ or @{.';
  if (branch.endsWith('.') || branch.endsWith('.lock') || branch.split('/').some((part) => part.startsWith('.') || part.endsWith('.lock'))) {
    return 'A branch name cannot end in ".lock" or ".".';
  }
  return null;
}
