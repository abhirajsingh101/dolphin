import { useEffect, useRef, useState } from 'react';
import { ExternalLink, RefreshCw, X } from 'lucide-react';
import { useApi } from './apiContext';
import { machineBridge } from './machines';
import { panelError, useModalPanel } from './useModalPanel';
import type { ListeningPort } from './types';
import './workflow.css';

/* What a machine is serving: this user's listening TCP ports, each with its
   process and project. On a machine reached over SSH, "Open on this
   computer" forwards the port over the machine's SSH connection first. */

export default function PortsPanel({ machineId, machineLabel, remote, onClose }: {
  machineId: string;
  machineLabel: string;
  remote: boolean;
  onClose: () => void;
}) {
  const { getListeningPorts } = useApi();
  // Read through a ref: a client that is rebuilt each render must not restart the poll.
  const loadPorts = useRef(getListeningPorts);
  loadPorts.current = getListeningPorts;
  const [ports, setPorts] = useState<ListeningPort[] | null>(null);
  const [error, setError] = useState('');
  const [opened, setOpened] = useState('');
  const [revision, setRevision] = useState(0);
  const panel = useRef<HTMLDivElement>(null);
  useModalPanel(panel, onClose);
  useEffect(() => {
    let current = true;
    const load = () => loadPorts.current()
      .then((rows) => { if (current) { setPorts(rows); setError(''); } })
      .catch((reason) => { if (current) setError(panelError(reason)); });
    void load();
    const timer = window.setInterval(load, 5000);
    return () => { current = false; window.clearInterval(timer); };
  }, [revision]);
  const action = remote ? 'Open on this computer' : 'Open in browser';
  const openPort = async (port: number) => {
    setOpened('');
    const open = machineBridge()?.openPort;
    if (!open) { setError('This version of Dolphin Desktop cannot open ports.'); return; }
    try {
      const result = await open(machineId, port);
      if (result.error) setError(result.error);
      else if (result.url) setOpened(`Opened ${result.url}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  return (
    <div className="workflow-scrim" role="presentation" onClick={onClose}>
      <div ref={panel} tabIndex={-1} className="workflow-panel" role="dialog" aria-modal="true" aria-label={`Ports on ${machineLabel}`}
        onClick={(event) => event.stopPropagation()}>
        <header className="workflow-header">
          <h2>Ports on {machineLabel}</h2>
          <small>Listening TCP ports of your processes</small>
          <button type="button" className="dt-btn dt-btn--ghost" aria-label="Refresh ports" onClick={() => setRevision((value) => value + 1)}><RefreshCw size={14} aria-hidden="true" /></button>
          <button type="button" className="dt-btn dt-btn--ghost" aria-label="Close" onClick={onClose}><X size={16} aria-hidden="true" /></button>
        </header>
        <div className="workflow-body">
          {ports === null && !error && <p role="status">Looking for listening ports…</p>}
          {error && <p role="alert">{error}</p>}
          {opened && <p role="status">{opened}</p>}
          {ports?.length === 0 && <p>Nothing of yours is listening on {machineLabel}.</p>}
          {!!ports?.length && (
            <ul className="workflow-list">
              {ports.map((row) => (
                <li key={`${row.pid}:${row.port}`}>
                  <span>
                    <strong>:{row.port}</strong> {row.process}
                    <small>{[row.project_name, row.address, `pid ${row.pid}`, row.command].filter(Boolean).join(' · ')}</small>
                  </span>
                  <button type="button" className="machine-action" aria-label={`${action}: port ${row.port}`} onClick={() => void openPort(row.port)}>
                    <ExternalLink size={13} aria-hidden="true" /> {action}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
