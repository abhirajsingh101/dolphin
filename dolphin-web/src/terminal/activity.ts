import { useSyncExternalStore } from 'react';
import type { Terminal } from '@xterm/xterm';
import { ProgressAddon } from '@xterm/addon-progress';

/* What a session's program says about itself: its OSC title, a bell rung
   while you were elsewhere, and OSC 9;4 progress. Keyed by terminalKey so the
   tab strip, the pinned rows and the window title can read it. The title is
   untrusted text: it is stripped of control characters, capped, and only ever
   rendered as text. */

export type TerminalProgress = { state: 0 | 1 | 2 | 3 | 4; value: number };
export type TerminalActivity = { title: string; bell: boolean; progress: TerminalProgress };

export const NO_ACTIVITY: TerminalActivity = Object.freeze({
  title: '',
  bell: false,
  progress: Object.freeze({ state: 0, value: 0 }) as TerminalProgress,
});
export const MAX_TITLE_LENGTH = 80;

export function sanitizeTerminalTitle(raw: string): string {
  const title = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const points = Array.from(title);
  return points.length > MAX_TITLE_LENGTH ? `${points.slice(0, MAX_TITLE_LENGTH - 1).join('')}…` : title;
}

const store = new Map<string, TerminalActivity>();
const listeners = new Set<() => void>();
function notify(): void {
  for (const listener of [...listeners]) listener();
}

export function getTerminalActivity(key: string): TerminalActivity {
  return store.get(key) ?? NO_ACTIVITY;
}

export function updateTerminalActivity(key: string, patch: Partial<TerminalActivity>): void {
  const current = getTerminalActivity(key);
  const next = { ...current, ...patch };
  if (next.title === current.title && next.bell === current.bell
    && next.progress.state === current.progress.state && next.progress.value === current.progress.value) return;
  store.set(key, next);
  notify();
}

export function clearTerminalBell(key: string): void {
  if (getTerminalActivity(key).bell) updateTerminalActivity(key, { bell: false });
}

export function forgetTerminalActivity(key: string): void {
  if (store.delete(key)) notify();
}

/** Forget every entry whose key starts with `prefix` (a removed project or machine). */
export function forgetTerminalActivityUnder(prefix: string): void {
  let changed = false;
  for (const key of [...store.keys()]) if (key.startsWith(prefix)) { store.delete(key); changed = true; }
  if (changed) notify();
}

export function subscribeTerminalActivity(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTerminalActivity(key: string | null | undefined): TerminalActivity {
  const read = () => (key ? getTerminalActivity(key) : NO_ACTIVITY);
  return useSyncExternalStore(subscribeTerminalActivity, read, () => NO_ACTIVITY);
}

export function progressState(progress: TerminalProgress): 'none' | 'normal' | 'error' | 'indeterminate' | 'paused' {
  return (['none', 'normal', 'error', 'indeterminate', 'paused'] as const)[progress.state] ?? 'none';
}

const clampValue = (value: number): number => (Number.isFinite(value) ? Math.min(100, Math.max(0, Math.round(value))) : 0);

export function attachTerminalActivity(
  terminal: Terminal,
  deps: { key: string; isForeground: () => boolean },
): () => void {
  const title = terminal.onTitleChange((raw) => updateTerminalActivity(deps.key, { title: sanitizeTerminalTitle(raw) }));
  const bell = terminal.onBell(() => {
    if (!deps.isForeground()) updateTerminalActivity(deps.key, { bell: true });
  });
  const progress = new ProgressAddon();
  terminal.loadAddon(progress);
  const change = progress.onChange(({ state, value }) => updateTerminalActivity(deps.key, {
    progress: { state: (state >= 0 && state <= 4 ? state : 0) as TerminalProgress['state'], value: clampValue(value) },
  }));
  return () => {
    title.dispose();
    bell.dispose();
    change.dispose();
    progress.dispose();
    /* A parked pane (hidden 60 s) keeps its bell until you look; the title and
       progress belong to a live terminal. Closing the tab calls
       forgetTerminalActivity. */
    updateTerminalActivity(deps.key, { title: '', progress: NO_ACTIVITY.progress });
    if (!getTerminalActivity(deps.key).bell) forgetTerminalActivity(deps.key);
  };
}
