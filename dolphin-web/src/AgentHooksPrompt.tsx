import { useEffect, useState } from 'react';
import { BellRing } from 'lucide-react';
import { API_BASE, request } from './api';
import './composerNotice.css';

/* Dolphin Desktop: one line above the composer, until Claude Code and Codex on
   this machine report their finished turns. Turn On adds Dolphin's hook to
   their settings; nothing changes without that click. */

type HookStatus = { agent: 'claude' | 'codex'; cli_found: boolean; installed: boolean };
const NAMES = { claude: 'Claude Code', codex: 'Codex' } as const;
const DISMISS_KEY = `dolphin.desktop.hooks-dismissed:${API_BASE}`;

export default function AgentHooksPrompt() {
  const [missing, setMissing] = useState<HookStatus[]>([]);
  const [state, setState] = useState<'idle' | 'working' | 'done' | 'failed'>('idle');
  const [message, setMessage] = useState('');

  useEffect(() => {
    let dismissed = false;
    try { dismissed = localStorage.getItem(DISMISS_KEY) === '1'; } catch { /* storage is optional */ }
    if (dismissed) return;
    request<unknown>('/api/desktop/agent-hooks')
      .then((rows) => setMissing(Array.isArray(rows) ? (rows as HookStatus[]).filter((row) => row.cli_found && !row.installed) : []))
      .catch(() => setMissing([]));
  }, []);

  if (missing.length === 0 && state !== 'done' && state !== 'failed') return null;
  const names = missing.map((row) => NAMES[row.agent]).join(' or ');

  const turnOn = async () => {
    setState('working');
    try {
      await request('/api/desktop/agent-hooks', { method: 'POST', body: JSON.stringify({ agents: missing.map((row) => row.agent) }) });
      setMessage(missing.some((row) => row.agent === 'codex')
        ? 'Notifications are on. Codex will ask you once to trust Dolphin’s hook; choose Trust.'
        : 'Notifications are on.');
      setState('done');
      setMissing([]);
    } catch (error) {
      setMessage(`Could not turn them on: ${error instanceof Error ? error.message : String(error)}`);
      setState('failed');
    }
  };

  return (
    <section className="signals-tray agent-hooks-prompt" aria-label="Agent notifications">
      {state === 'done' || state === 'failed' ? (
        <p role="status" className="signals-status agent-hooks-message">{message}</p>
      ) : (
        <div className="agent-hooks-row">
          <BellRing size={15} aria-hidden="true" />
          <span>Get notified when {names} finishes a turn.</span>
          <div className="signals-actions">
            <button type="button" className="signals-primary" disabled={state === 'working'} onClick={() => void turnOn()}>Turn On</button>
            <button type="button" onClick={() => {
              try { localStorage.setItem(DISMISS_KEY, '1'); } catch { /* storage is optional */ }
              setMissing([]);
            }}>Not Now</button>
          </div>
        </div>
      )}
    </section>
  );
}
