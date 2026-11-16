/* A project companion: the small character in a project's window and at the
   top of its Tasks tab. It has no state of its own. Its mood is read from the
   project's sessions, so it can only ever say what Dolphin already knows. */
import { seenAt, sessionState, type SessionState } from '../sessionState';
import type { ControlCenterSession } from '../types';

export type Mood = 'idle' | 'working' | 'done' | 'alert' | 'sleep';
export type Shape = 'pebble' | 'drop' | 'bean' | 'cube';
export type Accessory = 'none' | 'sprout' | 'antenna' | 'ears';

const SHAPES: Shape[] = ['pebble', 'drop', 'bean', 'cube'];
const ACCESSORIES: Accessory[] = ['none', 'sprout', 'antenna', 'ears'];

function hash(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) { h ^= seed.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d); h ^= h >>> 15;
  return h >>> 0;
}

/** The same project always gets the same character. */
export function faceOf(seed: string): { shape: Shape; accessory: Accessory } {
  const h = hash(seed);
  return { shape: SHAPES[h % SHAPES.length], accessory: ACCESSORIES[(h >>> 8) % ACCESSORIES.length] };
}

export type SessionMood = { name: string; state: SessionState; activityAt?: number };

/** Asleep once every session has been quiet this long. */
export const SLEEP_AFTER_MS = 30 * 60_000;

/** One mood for the whole project: what most needs the user comes first. */
export function moodOf(sessions: readonly SessionMood[], now: number): { mood: Mood; session?: string; label: string } {
  const first = (state: SessionState) => sessions.find((s) => s.state === state);
  const error = first('error');
  if (error) return { mood: 'alert', session: error.name, label: `${error.name} needs a look` };
  const unread = sessions.filter((s) => s.state === 'unread');
  if (unread.length) return { mood: 'done', session: unread[0].name, label: unread.length > 1 ? `${unread.length} sessions finished` : `${unread[0].name} finished` };
  const working = sessions.filter((s) => s.state === 'working');
  if (working.length) return { mood: 'working', session: working[0].name, label: working.length > 1 ? `${working.length} sessions working` : `Working in ${working[0].name}` };
  const latest = Math.max(0, ...sessions.map((s) => s.activityAt ?? 0));
  if (sessions.length && latest && now - latest > SLEEP_AFTER_MS) return { mood: 'sleep', label: 'All quiet' };
  return { mood: 'idle', label: 'Nothing running' };
}

/** A nudge only when the mood turns to something the user should see. */
export function nudgeFor(previous: Mood | undefined, next: { mood: Mood; label: string }): string | null {
  if (previous === undefined || previous === next.mood) return null;
  if (next.mood === 'done' || next.mood === 'alert') return next.label;
  return null;
}

export type Point = { x: number; y: number };
export type Box = { width: number; height: number; top: number };

/** Keep the whole character inside its window, below the window's header. */
export function clampPoint(point: Point, box: Box, size: number, inset = 8): Point {
  const maxX = Math.max(inset, box.width - size - inset);
  const maxY = Math.max(box.top + inset, box.height - size - inset);
  return {
    x: Math.min(maxX, Math.max(inset, point.x)),
    y: Math.min(maxY, Math.max(box.top + inset, point.y)),
  };
}

/** Let go near a side and it settles against that side. */
export function snapPoint(point: Point, box: Box, size: number, inset = 8, reach = 48): Point {
  const p = clampPoint(point, box, size, inset);
  const right = box.width - size - inset;
  if (p.x - inset < reach) return { ...p, x: inset };
  if (right - p.x < reach) return { ...p, x: Math.max(inset, right) };
  return p;
}

/** Saved as fractions of the window, so it keeps its place when the window resizes. */
export function toFraction(point: Point, box: Box, size: number): Point {
  const w = Math.max(1, box.width - size), h = Math.max(1, box.height - size);
  return { x: point.x / w, y: point.y / h };
}

export function fromFraction(fraction: Point, box: Box, size: number): Point {
  return clampPoint({ x: fraction.x * (box.width - size), y: fraction.y * (box.height - size) }, box, size);
}

const KEY = 'dolphin.companion.places';

export function savedPlace(projectId: string): Point | null {
  try {
    const all: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    const p = all && typeof all === 'object' ? (all as Record<string, unknown>)[projectId] : null;
    if (p && typeof p === 'object' && Number.isFinite((p as Point).x) && Number.isFinite((p as Point).y)) return p as Point;
  } catch { /* Storage is optional. */ }
  return null;
}

export function savePlace(projectId: string, fraction: Point): void {
  try {
    const all = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, Point>;
    localStorage.setItem(KEY, JSON.stringify({ ...all, [projectId]: fraction }));
  } catch { /* Storage is optional. */ }
}

/** Suggestions and Next up from the companion's latest reply that offered them. */
export type Suggestion = { title: string; why: string };
export type Plan = { messageId: string; suggestions: Suggestion[]; next: { task_id: string; reason: string } | null };

type ActivityLike = { tool: string; status: string; result: unknown };
type MessageLike = { id: string; role: string; payload?: { tool_activity?: ActivityLike[] } };

export function latestPlan(messages: readonly MessageLike[]): Plan | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== 'assistant') continue;
    const runs = (message.payload?.tool_activity ?? []).filter((a) => a.tool === 'suggest_tasks' && a.status === 'succeeded');
    const last = runs[runs.length - 1];
    const result = (last?.result as { result?: { suggestions?: unknown; next?: unknown } } | undefined)?.result;
    if (!result) continue;
    const suggestions = Array.isArray(result.suggestions)
      ? result.suggestions.filter((s): s is Suggestion => !!s && typeof s.title === 'string' && typeof s.why === 'string')
      : [];
    const next = result.next && typeof result.next === 'object' && typeof (result.next as { task_id?: unknown }).task_id === 'string'
      ? { task_id: (result.next as { task_id: string }).task_id, reason: String((result.next as { reason?: unknown }).reason ?? '') }
      : null;
    return { messageId: message.id, suggestions, next };
  }
  return null;
}

const DISMISSED = 'dolphin.companion.dismissed';

/** Suggestions the user waved away, per project; kept small. */
export function dismissedTitles(projectId: string): string[] {
  try {
    const all = JSON.parse(localStorage.getItem(DISMISSED) ?? '{}') as Record<string, unknown>;
    const list = all[projectId];
    return Array.isArray(list) ? list.filter((t): t is string => typeof t === 'string') : [];
  } catch { return []; }
}

export function dismissTitle(projectId: string, title: string): void {
  try {
    const all = JSON.parse(localStorage.getItem(DISMISSED) ?? '{}') as Record<string, string[]>;
    const list = [...(all[projectId] ?? []).filter((t) => t !== title), title].slice(-50);
    localStorage.setItem(DISMISSED, JSON.stringify({ ...all, [projectId]: list }));
  } catch { /* Storage is optional. */ }
}

export const sameTitle = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Each live session of a project, as the companion reads it. */
export function sessionMoods(sessions: readonly ControlCenterSession[], machine: string, projectId: string): SessionMood[] {
  return sessions.map((s) => ({
    name: s.name,
    state: sessionState(s, seenAt(machine, projectId, s.name)),
    activityAt: Date.parse(s.last_activity_at ?? s.turn_at ?? '') || undefined,
  }));
}
