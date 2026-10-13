import { gitSummary } from './gitStatus';
import type { GitStatus } from './types';

/** Branch, change count and ahead/behind, in the sidebar and window titles. */
export default function GitBadge({ status }: { status: GitStatus | null | undefined }) {
  const summary = gitSummary(status);
  if (!summary) return null;
  return (
    <span className="glass-git" data-dirty={(status?.dirty ?? 0) > 0} title={summary.label}>
      <span aria-hidden="true">{summary.text}</span>
      <span className="dt-sr-only">{summary.label}</span>
    </span>
  );
}
