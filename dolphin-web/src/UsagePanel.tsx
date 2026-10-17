import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useApi } from './apiContext';
import { AGENT_NAMES, usageLines } from './usageModel';
import { panelError, useModalPanel } from './useModalPanel';
import { useDialogParts } from './motion/dialogParts';
import type { UsageReport } from './types';
import './workflow.css';

/* Claude Code and Codex tokens on one machine, from the agents' own logs:
   the current 5-hour window and its burn rate, the last 7 days, and the
   limits Codex reports. */

export default function UsagePanel({ machineLabel, onClose }: { machineLabel: string; onClose: () => void }) {
  const { getUsage } = useApi();
  // Read through a ref: a client that is rebuilt each render must not restart the poll.
  const loadUsage = useRef(getUsage);
  loadUsage.current = getUsage;
  const [report, setReport] = useState<UsageReport | null>(null);
  const [error, setError] = useState('');
  const panel = useRef<HTMLDivElement>(null);
  useModalPanel(panel, onClose);
  const { Scrim, Panel } = useDialogParts();
  useEffect(() => {
    let current = true;
    const load = () => loadUsage.current()
      .then((found) => { if (current) { setReport(found); setError(''); } })
      .catch((reason) => { if (current) setError(panelError(reason)); });
    void load();
    const timer = window.setInterval(load, 60000);
    return () => { current = false; window.clearInterval(timer); };
  }, []);
  return (
    <Scrim className="workflow-scrim" role="presentation" onClick={onClose}>
      <Panel ref={panel} tabIndex={-1} className="workflow-panel" role="dialog" aria-modal="true" aria-label={`Usage on ${machineLabel}`}
        onClick={(event) => event.stopPropagation()}>
        <header className="workflow-header">
          <h2>Usage on {machineLabel}</h2>
          <small>Tokens from the agents’ own logs</small>
          <button type="button" className="dt-btn dt-btn--ghost" aria-label="Close" onClick={onClose}><X size={16} aria-hidden="true" /></button>
        </header>
        <div className="workflow-body">
          {!report && !error && <p role="status">Reading logs…</p>}
          {error && <p role="alert">{error}</p>}
          {report?.agents.map((agent) => (
            <section key={agent.agent} aria-label={AGENT_NAMES[agent.agent]}>
              <h3>{AGENT_NAMES[agent.agent]}</h3>
              {agent.found
                ? <ul className="workflow-list">{usageLines(agent).map((line, i) => <li key={`${i}:${line}`}><span>{line}</span></li>)}</ul>
                : <p className="workflow-note">No {AGENT_NAMES[agent.agent]} logs on {machineLabel}.</p>}
            </section>
          ))}
        </div>
      </Panel>
    </Scrim>
  );
}
