/* What the agent setup line offers each machine: Dolphin's hook, so the bell
   and system notifications hear when an agent finishes a turn. Agents get no
   memory tools; Dolphin's brain follows their work from their transcripts. */

export type Agent = 'claude' | 'codex';
export type HookRow = { agent: Agent; cli_found: boolean; installed: boolean };
export type SetupOffer = { machine: string; label?: string; hooks: Agent[]; text: string; action: string };

const NAMES: Record<Agent, string> = { claude: 'Claude Code', codex: 'Codex' };
const joined = (agents: Agent[]) => [...new Set(agents)].map((agent) => NAMES[agent]).join(' and ');

/* One key builder, in agentSetupKey.ts; re-exported under the name this file's callers use. */
export { agentSetupDismissKey as dismissKey } from './agentSetupKey';

export function offerFor(machine: string, label: string | undefined, hookRows: HookRow[]): SetupOffer | null {
  const hooks = hookRows.filter((row) => row.cli_found && !row.installed).map((row) => row.agent);
  if (!hooks.length) return null;
  const agents = joined(hooks);
  if (label) {
    return { machine, label, hooks, action: `Turn on notifications on ${label}`,
      text: `Turn on notifications on ${label}: ${agents} there will tell you when they finish a turn.` };
  }
  return { machine, hooks, action: 'Turn On', text: `Connect ${agents} to Dolphin: get notified when they finish a turn.` };
}

export function doneMessage(offer: SetupOffer): string {
  const trust = offer.hooks.includes('codex') ? ' Codex will ask you once to trust Dolphin’s hook; choose Trust.' : '';
  if (offer.label) return `${offer.label}: notifications are on for ${joined(offer.hooks)}.${trust}`;
  return `${joined(offer.hooks)}: notifications are on.${trust}`;
}
