import type { GitStatus, GitStatuses } from './types';

/** A project's or worktree's git state: short text for the sidebar, and the
    same facts in words for the tooltip and screen readers. */
export function gitSummary(status: GitStatus | null | undefined): { text: string; label: string } | null {
  if (!status) return null;
  const parts = [status.branch ?? status.head ?? 'no commits'];
  const words = [status.branch ? `Branch ${status.branch}` : status.head ? `Detached at ${status.head}` : 'No commits yet'];
  if (status.dirty) {
    parts.push(String(status.dirty));
    words.push(`${status.dirty} uncommitted ${status.dirty === 1 ? 'change' : 'changes'}`);
  }
  if (status.conflicted) words.push(`${status.conflicted} in conflict`);
  const arrows = [status.ahead ? `↑${status.ahead}` : '', status.behind ? `↓${status.behind}` : ''].filter(Boolean).join(' ');
  if (arrows) {
    parts.push(arrows);
    words.push(`${status.ahead} ahead and ${status.behind} behind ${status.upstream}`);
  } else if (status.upstream) {
    words.push(`up to date with ${status.upstream}`);
  } else if (status.branch) {
    words.push('no upstream');
  }
  return { text: parts.join(' · '), label: words.join(', ') };
}

const sameGit = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** A fresh answer, reusing the previous object for every status that did not change. */
export function mergeGit(previous: GitStatuses | undefined, next: GitStatuses): GitStatuses {
  if (!previous || !next.projects) return next;
  const keep = <T,>(old: Record<string, T> | undefined, fresh: Record<string, T> | undefined) => Object.fromEntries(
    Object.entries(fresh ?? {}).map(([key, value]) => [key, old && key in old && sameGit(old[key], value) ? old[key] : value]));
  const result: GitStatuses = {
    projects: keep(previous.projects, next.projects),
    sessions: keep(previous.sessions, next.sessions),
    errors: next.errors,
  };
  return sameGit(previous, result) ? previous : result;
}
