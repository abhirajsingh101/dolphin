/* Dolphin Desktop's first-run checklist, worked out from what a machine's
   helper reports (/api/desktop/environment, /api/desktop/agents,
   /api/desktop/agent-hooks, /api/brain). No React here, so firstRun.test.ts
   covers every row. FirstRunChecklist.tsx draws it. */

import type { AgentCli } from './api';
import { trustedInstallStart } from './agentInstall';

export type Agent = 'claude' | 'codex';
export type Environment = {
  helper_version: string;
  tmux: { version: string | null; bundled: boolean };
  agents: { agent: Agent; found: boolean; signed_in: boolean | null }[];
};
export type HookRow = { agent: Agent; cli_found: boolean; installed: boolean };
export type BrainState = { state: 'off' | 'missing' | 'installing' | 'ready' | 'failed'; optional?: boolean; step?: string; error?: string };
export type ChecklistAction =
  | { kind: 'install'; agent: Agent; label: string; name: string }
  | { kind: 'sign-in'; agent: Agent; label: string; name: string }
  | { kind: 'notifications'; agents: Agent[]; label: string; name: string }
  | { kind: 'memory'; label: string; name: string }
  | { kind: 'retry-memory'; label: string; name: string };
export type ChecklistItem = { id: 'tmux' | Agent | 'notifications' | 'memory'; label: string; done: boolean; detail: string; action?: ChecklistAction };
export type ChecklistInput = {
  environment: Environment | null;
  agents: AgentCli[] | null;
  hooks: HookRow[] | null;
  brain: BrainState | null;
  /** True when the desktop settings bridge exists, so memory can be chosen. */
  canChooseMemory: boolean;
};

/** Fired on window when memory was just turned on or retried, so the Memory
    line above the chat (BrainStatus.tsx) looks again. */
export const BRAIN_CHANGED = 'dolphin:brain-changed';

/** Fired on window when the checklist turned notifications on, so the agent
    setup line above the chat (AgentSetupPrompt.tsx) looks again instead of
    still offering what was just done. */
export const AGENT_SETUP_CHANGED = 'dolphin:agent-setup-changed';

const NAMES: Record<Agent, string> = { claude: 'Claude Code', codex: 'Codex' };
const joined = (agents: Agent[]) => agents.map((agent) => NAMES[agent]).join(' and ');

function tmuxItem({ tmux }: Environment): ChecklistItem {
  if (!tmux.version) return { id: 'tmux', label: 'tmux', done: false, detail: 'Not found. Dolphin needs tmux 3.0 or later.' };
  return { id: 'tmux', label: 'tmux', done: true, detail: tmux.bundled ? `Dolphin’s own tmux ${tmux.version}` : `tmux ${tmux.version}` };
}

function agentItem(cli: AgentCli, signedIn: boolean | null | undefined): ChecklistItem {
  const label = cli.name;
  if (!cli.found) {
    // Only a command the client knows is offered to run; otherwise the hint is shown as text.
    return trustedInstallStart(cli)
      ? { id: cli.agent, label, done: false, detail: 'Not installed.', action: { kind: 'install', agent: cli.agent, label: 'Install', name: `Install ${label}` } }
      : { id: cli.agent, label, done: false, detail: `Not installed. ${cli.install_hint ?? 'Install it yourself, then press Check Again.'}`.trim() };
  }
  if (signedIn === false) {
    return { id: cli.agent, label, done: false, detail: 'Installed. No sign-in found.', action: { kind: 'sign-in', agent: cli.agent, label: 'Sign In', name: `Sign in to ${label}` } };
  }
  return { id: cli.agent, label, done: true, detail: signedIn ? 'Installed and signed in.' : 'Installed.' };
}

function notificationsItem(hooks: HookRow[]): ChecklistItem | null {
  const found = hooks.filter((row) => row.cli_found);
  if (found.length === 0) return null;
  const missing = found.filter((row) => !row.installed).map((row) => row.agent);
  if (missing.length === 0) return { id: 'notifications', label: 'Notifications', done: true, detail: `On for ${joined(found.map((row) => row.agent))}.` };
  return {
    id: 'notifications', label: 'Notifications', done: false, detail: `Get told when ${joined(missing)} finishes a turn.`,
    action: { kind: 'notifications', agents: missing, label: 'Turn On', name: 'Turn on notifications' },
  };
}

function memoryItem(brain: BrainState, canChoose: boolean): ChecklistItem | null {
  switch (brain.state) {
    case 'ready':
      return { id: 'memory', label: 'Memory', done: true, detail: 'On.' };
    case 'installing':
    case 'missing':
      return { id: 'memory', label: 'Memory', done: false, detail: `Setting up… ${brain.step ?? ''}`.trim() };
    case 'failed':
      return { id: 'memory', label: 'Memory', done: false, detail: `Setup failed: ${brain.error ?? 'no detail'}`, action: { kind: 'retry-memory', label: 'Retry', name: 'Retry memory setup' } };
    case 'off':
      return brain.optional && canChoose
        ? { id: 'memory', label: 'Memory', done: false, detail: 'Optional. Dolphin remembers what you tell it. Downloads about 400 MB.', action: { kind: 'memory', label: 'Turn On', name: 'Turn on memory' } }
        : null;
  }
}

export function checklist(input: ChecklistInput): ChecklistItem[] {
  const items: (ChecklistItem | null)[] = [];
  if (input.environment) items.push(tmuxItem(input.environment));
  for (const cli of input.agents ?? []) {
    items.push(agentItem(cli, input.environment?.agents.find((row) => row.agent === cli.agent)?.signed_in));
  }
  if (input.hooks) items.push(notificationsItem(input.hooks));
  if (input.brain) items.push(memoryItem(input.brain, input.canChooseMemory));
  return items.filter((item): item is ChecklistItem => item !== null);
}

/** The agent setup line (AgentSetupPrompt.tsx) polls until memory is ready,
    but only while it is actually being set up. */
export function memoryStillSettingUp(rows: { cli_found: boolean; memory_ready: boolean; memory_state?: string }[]): boolean {
  return rows.some((row) => row.cli_found && !row.memory_ready
    && (row.memory_state === undefined || row.memory_state === 'installing' || row.memory_state === 'missing'));
}
