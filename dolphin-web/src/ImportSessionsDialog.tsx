import { useRef, useState } from 'react';
import type { PendingImport } from './api';
import { panelError, useModalPanel } from './useModalPanel';
import { useDialogParts } from './motion/dialogParts';
import './workflow.css';

/* Connecting to a machine with many tmux sessions running would fill the
   sidebar at once. More than five new folders are offered here first. */

export default function ImportSessionsDialog({ machineLabel, pending, onAnswer }: {
  machineLabel: string;
  pending: PendingImport[];
  /** The folders to add; [] adds none and is remembered; null asks again next launch.
   * A rejection keeps the dialog open and is shown in it. */
  onAnswer: (paths: string[] | null) => void | Promise<void>;
}) {
  const [chosen, setChosen] = useState(() => new Set(pending.map((item) => item.path)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const sending = useRef(false);
  const panel = useRef<HTMLDivElement>(null);
  const { Scrim, Panel } = useDialogParts();
  const toggle = (path: string) => setChosen((current) => {
    const next = new Set(current);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    return next;
  });
  // One answer at a time: a second click while the first is on its way does nothing.
  const answer = async (paths: string[] | null) => {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setError('');
    try {
      await onAnswer(paths);
    } catch (reason) {
      setError(panelError(reason));
      sending.current = false;
      setBusy(false);
    }
  };
  useModalPanel(panel, () => void answer(null));
  return (
    <Scrim className="workflow-scrim" role="presentation">
      <Panel ref={panel} tabIndex={-1} className="workflow-panel" role="dialog" aria-modal="true" aria-label={`Add projects from ${machineLabel}`}>
        <header className="workflow-header">
          <h2>Add {pending.length} projects from {machineLabel}?</h2>
        </header>
        <div className="workflow-body">
          <p>tmux sessions are running in these folders. Each folder you keep becomes a project, with its sessions under it.</p>
          <ul className="workflow-list">
            {pending.map((item) => (
              <li key={item.path}>
                <input type="checkbox" aria-label={item.name} checked={chosen.has(item.path)} disabled={busy} onChange={() => toggle(item.path)} />
                <span><strong>{item.name}</strong><small>{item.path} · {item.sessions.join(', ')}</small></span>
              </li>
            ))}
          </ul>
          {error && <p className="workflow-note" role="alert">{error}</p>}
        </div>
        <footer className="workflow-footer">
          <button type="button" className="dt-btn dt-btn--ghost" disabled={busy} onClick={() => void answer(null)}>Not now</button>
          <button type="button" className="dt-btn dt-btn--ghost" disabled={busy} onClick={() => void answer([])}>Don’t add</button>
          <button type="button" className="machine-action" disabled={busy || !chosen.size} onClick={() => void answer([...chosen])}>
            {chosen.size === 1 ? 'Add 1 project' : `Add ${chosen.size} projects`}
          </button>
        </footer>
      </Panel>
    </Scrim>
  );
}
