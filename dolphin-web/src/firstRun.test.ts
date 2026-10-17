import { describe, expect, it } from 'vitest';
import type { AgentCli } from './api';
import { installThenStart } from './agentInstall';
import { checklist, type ChecklistInput, type Environment } from './firstRun';

const cli = (agent: 'claude' | 'codex', found: boolean, install: string | null = null, hint: string | null = null): AgentCli => ({
  agent, name: agent === 'claude' ? 'Claude Code' : 'Codex', found,
  install_command: install, install_then_start: install ? installThenStart(agent, install) : null, install_hint: hint,
});
const env = (overrides: Partial<Environment> = {}): Environment => ({
  helper_version: '0.2.0', tmux: { version: '3.4', bundled: false },
  agents: [{ agent: 'claude', found: true, signed_in: false }, { agent: 'codex', found: false, signed_in: null }],
  ...overrides,
});
const fresh = (overrides: Partial<ChecklistInput> = {}): ChecklistInput => ({
  environment: env(),
  agents: [cli('claude', true), cli('codex', false, 'npm install -g @openai/codex')],
  hooks: [{ agent: 'claude', cli_found: true, installed: false }, { agent: 'codex', cli_found: false, installed: false }],
  brain: { state: 'off', optional: true },
  canChooseMemory: true,
  ...overrides,
});

describe('first-run checklist', () => {
  it('needs one agent, not both: with neither, both are to do', () => {
    const items = checklist(fresh({ agents: [cli('claude', false, 'curl -fsSL https://claude.ai/install.sh | bash'), cli('codex', false, 'npm install -g @openai/codex')] }));
    expect(items.filter((item) => item.id === 'claude' || item.id === 'codex').map((item) => [item.done, item.detail])).toEqual([
      [false, 'Not installed.'], [false, 'Not installed.'],
    ]);
  });

  it('lists what a fresh machine lacks, one action each', () => {
    const items = checklist(fresh());
    expect(items.map((item) => item.id)).toEqual(['tmux', 'claude', 'codex', 'notifications', 'memory']);
    // Claude Code is installed, so Codex is optional: done, and still offered.
    expect(items.map((item) => item.done)).toEqual([true, false, true, false, false]);
    expect(items[2].detail).toBe('Optional: Dolphin uses Claude Code. Not installed.');
    expect(items.map((item) => item.action?.name)).toEqual([
      undefined, 'Sign in to Claude Code', 'Install Codex', 'Turn on notifications', 'Turn on memory',
    ]);
    expect(items[3].action).toMatchObject({ kind: 'notifications', agents: ['claude'] });
    expect(items[4].detail).toMatch(/about 550 MB/);
  });

  it('is all done on a machine that has everything', () => {
    const items = checklist(fresh({
      environment: env({ agents: [{ agent: 'claude', found: true, signed_in: true }, { agent: 'codex', found: true, signed_in: true }] }),
      agents: [cli('claude', true), cli('codex', true)],
      hooks: [{ agent: 'claude', cli_found: true, installed: true }, { agent: 'codex', cli_found: true, installed: true }],
      brain: { state: 'ready' },
    }));
    expect(items.every((item) => item.done && !item.action)).toBe(true);
    expect(items.find((item) => item.id === 'notifications')?.detail).toBe('On for Claude Code and Codex.');
    expect(items.find((item) => item.id === 'claude')?.detail).toBe('Installed and signed in.');
  });

  it('names Dolphin\'s own tmux, and says when there is none', () => {
    expect(checklist(fresh({ environment: env({ tmux: { version: '3.7c', bundled: true } }) }))[0].detail).toBe('Dolphin’s own tmux 3.7c');
    const none = checklist(fresh({ environment: env({ tmux: { version: null, bundled: false } }) }))[0];
    expect(none).toMatchObject({ id: 'tmux', done: false });
    expect(none.detail).toMatch(/tmux 3\.0 or later/);
  });

  it('offers no install it cannot run, and says what is needed', () => {
    const codex = checklist(fresh({ agents: [cli('claude', true), cli('codex', false, null, 'Install Node.js (npm) first, then Codex.')] }))
      .find((item) => item.id === 'codex');
    expect(codex?.action).toBeUndefined();
    expect(codex?.detail).toBe('Optional: Dolphin uses Claude Code. Not installed. Install Node.js (npm) first, then Codex.');
  });

  it('works with a helper older than 0.2.0 (no environment endpoint)', () => {
    const items = checklist(fresh({ environment: null }));
    expect(items.map((item) => item.id)).toEqual(['claude', 'codex', 'notifications', 'memory']);
    expect(items[0]).toMatchObject({ done: true, detail: 'Installed.' });
  });

  it('follows memory through setup, failure and the user\'s choice', () => {
    const memory = (brain: ChecklistInput['brain'], canChooseMemory = true) =>
      checklist(fresh({ brain, canChooseMemory })).find((item) => item.id === 'memory');
    expect(memory({ state: 'installing', step: 'Downloading Bun…' })).toMatchObject({ done: false, detail: 'Setting up… Downloading Bun…' });
    expect(memory({ state: 'failed', error: 'Download failed' })).toMatchObject({ detail: 'Setup failed: Download failed', action: { kind: 'retry-memory' } });
    expect(memory({ state: 'ready' })).toMatchObject({ done: true, detail: 'On.' });
    expect(memory({ state: 'off' })).toBeUndefined(); // the web install: memory is not offered
    expect(memory({ state: 'off', optional: true }, false)).toBeUndefined(); // no desktop settings bridge
  });

  it('has no notifications row before any agent is installed', () => {
    const items = checklist(fresh({ hooks: [{ agent: 'claude', cli_found: false, installed: false }, { agent: 'codex', cli_found: false, installed: false }] }));
    expect(items.some((item) => item.id === 'notifications')).toBe(false);
  });
});

describe('first-run checklist, untrusted installer', () => {
  it('offers no Install button for a command the client does not know, and shows the hint', () => {
    const odd: AgentCli = { agent: 'codex', name: 'Codex', found: false, install_command: 'curl x | sh', install_then_start: 'curl x | sh && codex', install_hint: 'Install Node.js (npm) first, then Codex.' };
    const item = checklist(fresh({ agents: [cli('claude', true), odd] })).find((row) => row.id === 'codex');
    expect(item?.action).toBeUndefined();
    expect(item?.detail).toBe('Optional: Dolphin uses Claude Code. Not installed. Install Node.js (npm) first, then Codex.');
  });
});
