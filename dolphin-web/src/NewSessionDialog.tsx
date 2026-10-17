import { trustedInstallStart } from './agentInstall';
import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { AgentCli } from './api';
import { useApi } from './apiContext';
import { useSetting } from './settings';
import { branchProblem } from './branchName';
import type { WorktreeOptions } from './types';
import { useDialogParts } from './motion/dialogParts';
import './newSession.css';

/* Dolphin Desktop: New Session asks what to run: Claude Code, Codex, a tmux
   session or a plain terminal. An agent this host lacks is offered as an
   install that runs, visibly, in the new terminal and then starts the agent.
   Nothing is installed without that click. "Always start this" makes the
   choice the default, so + starts it without asking (Settings changes it). */

export type SessionMode = 'shell' | 'claude' | 'codex' | 'terminal';
export type SessionChoice = { mode: SessionMode; startup?: string; worktree?: { branch: string; runSetup: boolean } };

export type SessionTile = { key: string; number: number; title: string; detail: string; command: string | null; mode: SessionMode; choice: SessionChoice | null };

export function sessionTiles(agents: AgentCli[], inWorktree = false): SessionTile[] {
  const tiles: Omit<SessionTile, 'number'>[] = agents.map((agent) => agent.found
    ? { key: agent.agent, title: agent.name, detail: `Starts ${agent.name} in a new terminal.`, command: null, mode: agent.agent, choice: { mode: agent.agent } }
    : trustedInstallStart(agent)
      ? { key: agent.agent, title: `Install ${agent.name}`, detail: inWorktree ? 'Installs first; starts in the project folder. Runs this in a new terminal, then starts it:' : 'Not found on this machine. Runs this in a new terminal, then starts it:', command: agent.install_command, mode: agent.agent, choice: { mode: 'shell', startup: trustedInstallStart(agent) ?? undefined } }
      : { key: agent.agent, title: agent.name, detail: `Not found on this machine. ${agent.install_hint ?? 'Install it yourself.'}`.trim(), command: null, mode: agent.agent, choice: null });
  tiles.push({ key: 'shell', title: 'tmux Session', detail: 'A shell in tmux. It keeps running after you close Dolphin.', command: null, mode: 'shell', choice: { mode: 'shell' } });
  tiles.push({ key: 'terminal', title: 'Terminal', detail: 'A plain shell, without tmux. It ends when you close it or quit Dolphin.', command: null, mode: 'terminal', choice: { mode: 'terminal' } });
  return tiles.map((tile, index) => ({ ...tile, number: index + 1 }));
}

export function defaultTile(tiles: SessionTile[], agent: 'ask' | SessionMode): SessionTile | undefined {
  return tiles.find((tile) => tile.mode === agent && tile.choice) ?? tiles.find((tile) => tile.choice);
}

/* The install command is text to read and copy; showing it runs nothing. */
export function NewSessionOptions({ tiles, onChoose }: { tiles: SessionTile[]; onChoose: (choice: SessionChoice, tile: SessionTile) => void }) {
  return (
    <>
      {tiles.map((tile) => (
        <button key={tile.key} className="new-session-option" type="button" data-tile={tile.key} aria-keyshortcuts={String(tile.number)}
          disabled={!tile.choice} onClick={() => tile.choice && onChoose(tile.choice, tile)}>
          <kbd className="new-session-number" aria-hidden="true">{tile.number}</kbd>
          <span>
            <strong>{tile.title}</strong>
            <small>{tile.detail}</small>
            {tile.command && <code className="new-session-command">{tile.command}</code>}
          </span>
        </button>
      ))}
    </>
  );
}

export default function NewSessionDialog({ projectId, projectName, onChoose, onClose }: {
  projectId: string;
  projectName: string;
  onChoose: (choice: SessionChoice) => void;
  onClose: () => void;
}) {
  const { getAgentClis, getWorktreeOptions } = useApi();
  const [agents, setAgents] = useState<AgentCli[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [options, setOptions] = useState<WorktreeOptions | null>(null);
  const [useWorktree, setUseWorktree] = useState(false);
  const [branch, setBranch] = useState('');
  const [runSetup, setRunSetup] = useState(true);
  const panelRef = useRef<HTMLDivElement>(null);
  const [defaultAgent, setDefaultAgent] = useSetting('newSession.defaultAgent');
  const [always, setAlways] = useState(false);
  const tiles = agents ? sessionTiles(agents, useWorktree && Boolean(options?.git)) : null;
  const { Scrim, Panel } = useDialogParts();

  useEffect(() => {
    getAgentClis().then(setAgents).catch(() => { setFailed(true); setAgents([]); });
    getWorktreeOptions(projectId)
      .then((found) => { setOptions(found); setBranch(found.suggested_branch); })
      .catch(() => setOptions(null));
  }, []);

  useEffect(() => {
    if (!tiles) return;
    const tile = defaultTile(tiles, defaultAgent);
    panelRef.current?.querySelector<HTMLButtonElement>(`.new-session-option[data-tile="${tile?.key ?? 'shell'}"]`)?.focus();
  }, [agents]);

  const problem = useWorktree && options?.git ? branchProblem(branch) : null;
  /* Where the session runs: the project folder, or a new worktree. An install
     tile runs in the project folder, so it is never moved. */
  const choose = (choice: SessionChoice, tile?: SessionTile) => {
    if (always && tile) setDefaultAgent(tile.mode);
    if (!useWorktree || !options?.git || choice.startup) { onChoose(choice); return; }
    if (problem) return;
    onChoose({ ...choice, worktree: { branch: branch.trim(), runSetup: options.setup && runSetup } });
  };

  const cycleFocus = (backwards: boolean) => {
    const items = [...(panelRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)') ?? [])];
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    items[(index + (backwards ? -1 : 1) + items.length) % items.length].focus();
  };

  return (
    <Scrim className="new-session-scrim" onClick={onClose} role="presentation">
      <Panel
        aria-label={`New session in ${projectName}`}
        aria-modal="true"
        className="new-session-panel"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (/^[1-9]$/.test(event.key) && tiles) {
            const target = event.target as HTMLElement;
            if (target.closest('input, textarea, select, [contenteditable="true"]')) return;
            const tile = tiles[Number(event.key) - 1];
            if (tile?.choice) { event.preventDefault(); choose(tile.choice, tile); }
            return;
          }
          if (event.key === 'Escape') { event.preventDefault(); onClose(); }
          else if (event.key === 'Tab') { event.preventDefault(); cycleFocus(event.shiftKey); }
        }}
        ref={panelRef}
        role="dialog"
      >
        <header className="new-session-header">
          <h2>New session in {projectName}</h2>
          <button aria-label="Close" className="dt-btn dt-btn--ghost" onClick={onClose} type="button">
            <X aria-hidden="true" size={16} />
          </button>
        </header>
        {options?.git && (
          <fieldset className="new-session-worktree">
            <label><input type="checkbox" checked={useWorktree} onChange={(event) => setUseWorktree(event.target.checked)} /> In a new worktree</label>
            {useWorktree && (
              <>
                <label className="new-session-branch">Branch <input aria-label="Branch" aria-invalid={problem ? true : undefined} value={branch} spellCheck={false} onChange={(event) => setBranch(event.target.value)} /></label>
                {problem && <small className="new-session-problem" role="alert">{problem}</small>}
                <small>
                  {options.env_files.length ? `Copies ${options.env_files.join(', ')}.` : 'No .env files to copy.'} The folder goes beside the repository, in .dolphin-worktrees.
                </small>
                {options.setup && (
                  <label><input type="checkbox" checked={runSetup} onChange={(event) => setRunSetup(event.target.checked)} /> Run .dolphin/setup first</label>
                )}
              </>
            )}
          </fieldset>
        )}
        <div className="new-session-options">
          {agents === null && <p className="new-session-note" role="status">Checking for Claude Code and Codex…</p>}
          {tiles && <NewSessionOptions tiles={tiles} onChoose={choose} />}
          {failed && <p className="new-session-note" role="status">Could not check for agents. You can still open a shell and run one yourself.</p>}
        </div>
        <footer className="new-session-footer">
          <label><input type="checkbox" checked={always} onChange={(event) => setAlways(event.target.checked)} /> Always start this</label>
          <small>{always ? '+ will start your choice without asking. Change it in Settings.' : 'Choose what + starts, or ask each time, in Settings.'}</small>
        </footer>
      </Panel>
    </Scrim>
  );
}
