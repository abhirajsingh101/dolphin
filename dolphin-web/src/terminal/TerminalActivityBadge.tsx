import type { CSSProperties } from 'react';
import { Bell } from 'lucide-react';

import { progressState, useTerminalActivity } from './activity';

const PROGRESS_LABEL = { normal: 'Progress', error: 'Failed', indeterminate: 'Working', paused: 'Paused' } as const;

/** A session's bell and progress, on its tab and pinned row. Renders nothing
    when there is neither. Static: it does not pulse. */
export default function TerminalActivityBadge({ activityKey }: { activityKey: string }) {
  const { bell, progress } = useTerminalActivity(activityKey);
  const state = progressState(progress);
  const measured = state === 'normal' || state === 'error' || state === 'paused';
  return <>
    {state !== 'none' && <span className="glass-terminal-progress" role="progressbar" data-state={state}
      aria-label={PROGRESS_LABEL[state]} aria-valuemin={0} aria-valuemax={100}
      aria-valuenow={measured ? progress.value : undefined}
      style={{ '--progress': `${measured ? progress.value : 100}%` } as CSSProperties} />}
    {bell && <span className="glass-terminal-bell" role="img" aria-label="Bell"><Bell size={11} aria-hidden="true" /></span>}
  </>;
}
