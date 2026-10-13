import { useEffect, useState } from 'react';
import type { ControlCenterSession } from './types';

/* What a session's glyph shows (spec "Session agent state"): from what its
   machine reports (turn_state, turn_at, pane_dead) and when this window last
   saw it. Seen times live in localStorage `dolphin.seen-turns`, one per
   machine|project|session; a session counts as seen when its terminal is
   focused. */

export type SessionState = 'working' | 'unread' | 'error' | 'idle';

export const STATE_LABEL: Record<SessionState, string> = {
  working: 'Working',
  unread: 'Finished, not seen yet',
  error: 'Error',
  idle: 'Idle',
};

type StateInput = Pick<ControlCenterSession, 'observation_state'>
  & Partial<Pick<ControlCenterSession, 'turn_state' | 'turn_at' | 'pane_dead'>>;

export function sessionState(s: StateInput, seenAt: number | undefined): SessionState {
  if (s.pane_dead || s.observation_state === 'degraded') return 'error';
  if (s.turn_state === 'working') return 'working';
  if (s.turn_state === 'finished' && s.turn_at) {
    const at = Date.parse(s.turn_at);
    if (Number.isFinite(at) && at > (seenAt ?? -Infinity)) return 'unread';
  }
  return 'idle';
}

const KEY = 'dolphin.seen-turns';
const MAX_SEEN = 500;
const EVENT = 'dolphin:seen-turns';
const idOf = (machine: string, projectId: string, session: string) => `${machine}|${projectId}|${session}`;

let cache: Record<string, number> | null = null;

function stored(): Record<string, number> {
  try {
    const raw: unknown = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? '{}');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return Object.fromEntries(Object.entries(raw).filter(([, value]) => typeof value === 'number' && Number.isFinite(value))) as Record<string, number>;
  } catch {
    return {};
  }
}

const all = () => (cache ??= stored());

export function seenAt(machine: string, projectId: string, session: string): number | undefined {
  return all()[idOf(machine, projectId, session)];
}

/** Callers should pass the session's turn_at: the seen value is then that
    remote turn time (compared like with like, whatever the remote clock says);
    without it, this machine's Date.now(). */
export function markSeen(machine: string, projectId: string, session: string, turnAt?: string | null): void {
  const turn = turnAt ? Date.parse(turnAt) : NaN;
  const known = Number.isFinite(turn);
  const at = known ? turn : Date.now();
  const id = idOf(machine, projectId, session);
  const seen = all();
  if (!known && (seen[id] ?? -Infinity) >= at) return;
  seen[id] = at;
  cache = Object.fromEntries(Object.entries(seen).sort((a, b) => b[1] - a[1]).slice(0, MAX_SEEN));
  try { globalThis.localStorage?.setItem(KEY, JSON.stringify(cache)); } catch { /* storage is optional */ }
  globalThis.dispatchEvent?.(new Event(EVENT));
}

/** A number that changes whenever a session is marked seen, for re-rendering. */
export function useSeenTurns(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const bump = () => setVersion((value) => value + 1);
    window.addEventListener(EVENT, bump);
    return () => window.removeEventListener(EVENT, bump);
  }, []);
  return version;
}
