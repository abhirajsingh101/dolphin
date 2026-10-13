import type { AgentCli } from './api';

/* The helper sends the command that installs an agent, and the client types it
   into a shell. Only the commands dolphin-backend/app/agent_clis.py builds are
   accepted; anything else is shown as text and never typed. */

const CLAUDE_INSTALL = 'curl -fsSL https://claude.ai/install.sh | bash';
const KNOWN: Record<AgentCli['agent'], string[]> = {
  claude: [CLAUDE_INSTALL],
  codex: ['npm install -g @openai/codex', 'brew install --cask codex'],
};

/** The helper's install-then-start line for `agent`, exactly as it builds it. */
export const installThenStart = (agent: AgentCli['agent'], install: string) =>
  `${install} && { command -v ${agent} >/dev/null || export PATH="$HOME/.local/bin:$PATH"; } && ${agent}`;

/** What to type to install and start `cli`, or null when the helper's command is not a known one. */
export function trustedInstallStart(cli: AgentCli): string | null {
  const install = cli.install_command;
  if (!install || !KNOWN[cli.agent]?.includes(install)) return null;
  return cli.install_then_start === installThenStart(cli.agent, install) ? cli.install_then_start : null;
}
