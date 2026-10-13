import type { AgentUsage } from './types';

export const AGENT_NAMES = { claude: 'Claude Code', codex: 'Codex' } as const;

/** One decimal under 10, none from 10; "9.99" rounds to "10", not "10.0". */
function scaled(value: number): string {
  if (value >= 10) return String(Math.round(value));
  const one = value.toFixed(1);
  return one === '10.0' ? '10' : one;
}

export function formatTokens(n: number): string {
  if (n < 1_000) return String(n);
  const thousands = scaled(n / 1_000);
  if (n < 1_000_000 && Number(thousands) < 1_000) return `${thousands}k`;
  return `${scaled(n / 1_000_000)}M`;
}

export function windowLabel(minutes: number): string {
  if (minutes === 300) return '5 hours';
  if (minutes === 10080) return '7 days';
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;
  if (minutes % 1440 === 0) return plural(minutes / 1440, 'day');
  if (minutes % 60 === 0) return plural(minutes / 60, 'hour');
  return `${minutes} min`;
}

export type Clock = (date: Date) => string;

/** Today: "17:00". Another day: "Thu 17:00". */
export const clock: Clock = (date) => (date.toDateString() === new Date().toDateString()
  ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  : date.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }));

/** ", resets at 17:00", the given `past` wording once it has gone by, or nothing for a missing or unparseable time. */
function resetClause(iso: string | null, time: Clock, now: Date, past: string): string {
  if (!iso) return '';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  return at.getTime() <= now.getTime() ? `, ${past}` : `, resets at ${time(at)}`;
}

export function usageLines(agent: AgentUsage, time: Clock = clock, now: Date = new Date()): string[] {
  const lines: string[] = [];
  const block = agent.five_hour;
  lines.push(block
    ? `5-hour window: ${formatTokens(block.tokens)} tokens${block.burn_per_minute == null ? '' : `, ${formatTokens(block.burn_per_minute)} a minute`}${resetClause(block.ends_at, time, now, 'window ended')}`
    : '5-hour window: not started');
  lines.push(`7 days: ${formatTokens(agent.seven_day.tokens)} tokens`);
  for (const limit of agent.limits) {
    lines.push(`Limit, ${windowLabel(limit.window_minutes)}: ${Math.round(limit.used_percent)}% used${resetClause(limit.resets_at, time, now, 'reset')}`);
  }
  return lines;
}
