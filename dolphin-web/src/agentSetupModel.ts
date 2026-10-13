/* What the agent setup line offers each machine. This computer: Dolphin's
   hook (finished-turn notifications) and Dolphin's memory. Another machine:
   the hook only; its finished turns are what the bell and system
   notifications need from it. */

export type Agent = 'claude' | 'codex';
export type HookRow = { agent: Agent; cli_found: boolean; installed: boolean };
export type MemoryRow = { agent: Agent; cli_found: boolean; memory_ready: boolean; memory_state?: string; connected: boolean };
export type SetupOffer = { machine: string; label?: string; hooks: Agent[]; memory: Agent[]; text: string; action: string };

const NAMES: Record<Agent, string> = { claude: 'Claude Code', codex: 'Codex' };
const joined = (agents: Agent[]) => [...new Set(agents)].map((agent) => NAMES[agent]).join(' and ');

/* One key builder, in agentSetupKey.ts; re-exported under the name this file's callers use. */
export { agentSetupDismissKey as dismissKey } from './agentSetupKey';

export function offerFor(machine: string, label: string | undefined, hookRows: HookRow[], memoryRows: MemoryRow[]): SetupOffer | null {
  const hooks = hookRows.filter((row) => row.cli_found && !row.installed).map((row) => row.agent);
  const memory = label ? [] : memoryRows.filter((row) => row.cli_found && row.memory_ready && !row.connected).map((row) => row.agent);
  if (!hooks.length && !memory.length) return null;
  const agents = joined([...hooks, ...memory]);
  if (label) {
    return { machine, label, hooks, memory, action: `Turn on notifications on ${label}`,
      text: `Turn on notifications on ${label}: ${agents} there will tell you when they finish a turn.` };
  }
  const what = hooks.length && memory.length
    ? 'get notified when they finish a turn, and let them share Dolphin’s memory.'
    : hooks.length ? 'get notified when they finish a turn.' : 'let them share Dolphin’s memory, so what you tell Dolphin reaches them too.';
  return { machine, hooks, memory, action: 'Turn On', text: `Connect ${agents} to Dolphin: ${what}` };
}

export function doneMessage(offer: SetupOffer): string {
  const trust = offer.hooks.includes('codex') ? ' Codex will ask you once to trust Dolphin’s hook; choose Trust.' : '';
  if (offer.label) return `${offer.label}: notifications are on for ${joined(offer.hooks)}.${trust}`;
  const done = [offer.hooks.length ? 'notifications are on' : '', offer.memory.length ? 'they share Dolphin’s memory in new sessions' : '']
    .filter(Boolean).join(', and ');
  return `${joined([...offer.hooks, ...offer.memory])}: ${done}.${trust}`;
}
