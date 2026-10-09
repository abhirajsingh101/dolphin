import { useEffect, useRef, useState } from 'react';
import { Download, SquareTerminal, X } from 'lucide-react';
import { getAgentClis, type AgentCli } from './api';
import './newSession.css';

/* Dolphin Desktop: New Session asks what to run. An agent this host lacks is
   offered as an install that runs, visibly, in the new terminal and then
   starts the agent. Nothing is installed without that click. */

export type SessionChoice = { mode: 'shell' | 'claude' | 'codex'; startup?: string };

export default function NewSessionDialog({ projectName, onChoose, onClose }: {
  projectName: string;
  onChoose: (choice: SessionChoice) => void;
  onClose: () => void;
}) {
  const [agents, setAgents] = useState<AgentCli[] | null>(null);
  const [failed, setFailed] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    getAgentClis().then(setAgents).catch(() => { setFailed(true); setAgents([]); });
  }, []);

  useEffect(() => {
    panelRef.current?.querySelector<HTMLButtonElement>('.new-session-option:not(:disabled)')?.focus();
  }, [agents]);

  const cycleFocus = (backwards: boolean) => {
    const items = [...(panelRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(index + (backwards ? -1 : 1) + items.length) % items.length].focus();
  };

  return (
    <div className="new-session-scrim" onClick={onClose} role="presentation">
      <div
        aria-label={`New session in ${projectName}`}
        aria-modal="true"
        className="new-session-panel"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
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
        <div className="new-session-options">
          {agents === null && <p className="new-session-note" role="status">Checking for Claude Code and Codex…</p>}
          {agents?.map((agent) => agent.found ? (
            <button key={agent.agent} className="new-session-option" type="button" onClick={() => onChoose({ mode: agent.agent })}>
              <SquareTerminal aria-hidden="true" size={16} />
              <span><strong>{agent.name}</strong><small>Starts {agent.name} in a new terminal.</small></span>
            </button>
          ) : agent.install_then_start ? (
            <button key={agent.agent} className="new-session-option" type="button"
              onClick={() => onChoose({ mode: 'shell', startup: agent.install_then_start ?? undefined })}>
              <Download aria-hidden="true" size={16} />
              <span>
                <strong>Install {agent.name}</strong>
                <small>Not found on this machine. Runs <code>{agent.install_command}</code> in a new terminal, then starts it.</small>
              </span>
            </button>
          ) : (
            <button key={agent.agent} className="new-session-option" type="button" disabled>
              <Download aria-hidden="true" size={16} />
              <span><strong>{agent.name}</strong><small>Not found on this machine. {agent.install_hint}</small></span>
            </button>
          ))}
          {failed && <p className="new-session-note" role="status">Could not check for agents. You can still open a shell and run one yourself.</p>}
          <button className="new-session-option" type="button" onClick={() => onChoose({ mode: 'shell' })}>
            <SquareTerminal aria-hidden="true" size={16} />
            <span><strong>Shell</strong><small>A plain terminal in the project folder.</small></span>
          </button>
        </div>
      </div>
    </div>
  );
}
