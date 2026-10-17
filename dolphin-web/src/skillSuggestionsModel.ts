import type { SkillSuggestion, SkillSuggestions } from './types';

/* What the skill suggestions line shows, apart from React: the answer the
   helper gave, checked; the headline; the chips; the install count. */

/** At most this many cards show at once. */
export const MAX_SHOWN = 2;
/** The line looks again this often, and when the window regains focus. */
export const POLL_MS = 30 * 60_000;
/** Settings changed the feature or asked for a fresh look: the line asks again. */
export const SKILL_SUGGESTIONS_CHANGED = 'dolphin:skill-suggestions-changed';

const KINDS = new Set(['skill', 'plugin']);
const AGENTS = new Set(['claude', 'codex', 'any']);
const text = (value: unknown): value is string => typeof value === 'string';

function item(value: unknown): SkillSuggestion | null {
  if (typeof value !== 'object' || value === null) return null;
  const row = value as Record<string, unknown>;
  if (!text(row.key) || !row.key || !text(row.name) || !row.name.trim() || !text(row.install) || !text(row.reason)) return null;
  if (!KINDS.has(row.kind as string)) return null;
  return {
    key: row.key,
    kind: row.kind as SkillSuggestion['kind'],
    name: row.name.trim(),
    source: text(row.source) ? row.source : '',
    url: text(row.url) ? row.url : '',
    install: row.install.trim(),
    reason: row.reason.trim(),
    project: text(row.project) && row.project.trim() ? row.project.trim() : null,
    installs: typeof row.installs === 'number' && Number.isFinite(row.installs) && row.installs >= 0 ? row.installs : null,
    agent: AGENTS.has(row.agent as string) ? (row.agent as SkillSuggestion['agent']) : 'any',
  };
}

/** The helper's answer, or null when it is not one (an older helper, a proxy page). */
export function parseSuggestions(value: unknown): SkillSuggestions | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (typeof body.enabled !== 'boolean' || !Array.isArray(body.items)) return null;
  const seen = new Set<string>();
  const items = body.items.map(item).filter((row): row is SkillSuggestion => {
    if (!row || seen.has(row.key)) return false;
    seen.add(row.key);
    return true;
  });
  return { enabled: body.enabled, items, generated_at: text(body.generated_at) ? body.generated_at : null };
}

/** The cards to show: not dismissed, at most MAX_SHOWN; none while the feature is off. */
export function shownSuggestions(data: SkillSuggestions | null, dismissed: ReadonlySet<string>): SkillSuggestion[] {
  if (!data?.enabled) return [];
  return data.items.filter((row) => !dismissed.has(row.key)).slice(0, MAX_SHOWN);
}

/** "3 skills that fit your recent work", "1 plugin that fits…", "2 skills and plugins…". */
export function headline(items: SkillSuggestion[]): string {
  const kinds = new Set(items.map((row) => row.kind));
  const one = items.length === 1;
  const noun = kinds.size > 1 ? 'skills and plugins' : `${kinds.has('plugin') ? 'plugin' : 'skill'}${one ? '' : 's'}`;
  return `${items.length} ${noun} that ${one ? 'fits' : 'fit'} your recent work`;
}

export const kindLabel = (kind: SkillSuggestion['kind']) => (kind === 'plugin' ? 'Plugin' : 'Skill');

/** The agent it is for, or null when it works with either. */
export const agentLabel = (agent: SkillSuggestion['agent']) => (agent === 'claude' ? 'Claude Code' : agent === 'codex' ? 'Codex' : null);

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

/** "5.7K installs", "1 install"; null when the count is unknown. */
export function formatInstalls(installs: number | null): string | null {
  if (installs === null || !Number.isFinite(installs) || installs < 0) return null;
  const count = Math.round(installs);
  return `${compact.format(count)} ${count === 1 ? 'install' : 'installs'}`;
}

/** The link, only when it is a web page: anything else is not opened. */
export function safeLink(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null;
  } catch {
    return null;
  }
}
