import type { SessionState } from './sessionState';
import type { ControlCenterSession } from './types';

/* The compact projects list's rules, kept out of the components so they can
   be tested directly. */

/** Which projects the list shows. One with sessions always does. The Inbox
    shows only with sessions. Other empty projects wait behind one
    "N projects with no sessions" row, except one linked in this window
    (`revealed`) and any while a filter is typed. */
export function visibleProjects<T extends { id: string; is_inbox: boolean; sessions: unknown[] }>(
  projects: T[],
  options: { revealed: ReadonlySet<string>; showEmpty: boolean; filtering: boolean },
): { shown: T[]; hiddenEmpty: number } {
  const shown: T[] = [];
  let hiddenEmpty = 0;
  for (const project of projects) {
    if (project.sessions.length > 0) shown.push(project);
    else if (project.is_inbox) continue;
    else if (options.showEmpty || options.filtering || options.revealed.has(project.id)) shown.push(project);
    else hiddenEmpty += 1;
  }
  return { shown, hiddenEmpty };
}

const SUMMARY_ORDER: SessionState[] = ['working', 'unread', 'error'];

/** A collapsed project's one line, e.g. "2 working · 1 unread". Idle sessions
    are not counted; with nothing else to say it is the session count. */
export function projectSummary(states: SessionState[]): string {
  const parts = SUMMARY_ORDER
    .map((state) => [state, states.filter((s) => s === state).length] as const)
    .filter(([, count]) => count > 0)
    .map(([state, count]) => `${count} ${state}`);
  return parts.length ? parts.join(' · ') : `${states.length} ${states.length === 1 ? 'session' : 'sessions'}`;
}

/** "now", "3m", "3h", "3d", or "" without a usable time. */
export function elapsed(iso: string | null | undefined, now: number): string {
  if (!iso) return '';
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '';
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/** A row's time: since its turn changed, else since its session last printed. */
export function rowTime(s: Pick<ControlCenterSession, 'turn_at' | 'last_activity_at'>): string | null | undefined {
  return s.turn_at ?? s.last_activity_at;
}

/** The row j/k moves to from `index` (-1: none focused), clamped to the list. */
export function nextRow(count: number, index: number, delta: 1 | -1): number {
  if (count <= 0) return -1;
  if (index < 0) return delta > 0 ? 0 : count - 1;
  return Math.min(count - 1, Math.max(0, index + delta));
}
