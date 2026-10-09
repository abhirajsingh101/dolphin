import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { API_BASE, request } from './api';
import './composerNotice.css';

/* Dolphin Desktop: one line above the composer that connects the installed
   agents (Claude Code, Codex) to Dolphin, offering whatever is still missing:
   - notifications: Dolphin's hook reports each finished turn to the bell;
   - memory: Dolphin's GBrain as an MCP server, once memory is set up.
   Turn On does both; nothing changes without that click. */

type Agent = 'claude' | 'codex';
type HookRow = { agent: Agent; cli_found: boolean; installed: boolean };
type MemoryRow = { agent: Agent; cli_found: boolean; memory_ready: boolean; connected: boolean };
const NAMES: Record<Agent, string> = { claude: 'Claude Code', codex: 'Codex' };
const DISMISS_KEY = `dolphin.desktop.agent-setup-dismissed:${API_BASE}`;

const joined = (agents: Agent[]) => [...new Set(agents)].map((agent) => NAMES[agent]).join(' and ');

export default function AgentSetupPrompt() {
  const [hooks, setHooks] = useState<Agent[]>([]);
  const [memory, setMemory] = useState<Agent[]>([]);
  const [state, setState] = useState<'idle' | 'working' | 'done' | 'failed'>('idle');
  const [message, setMessage] = useState('');

  useEffect(() => {
    try { if (localStorage.getItem(DISMISS_KEY) === '1') return undefined; } catch { /* storage is optional */ }
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const [hookRows, memoryRows] = await Promise.all([
          request<HookRow[]>('/api/desktop/agent-hooks'),
          request<MemoryRow[]>('/api/desktop/agent-memory'),
        ]);
        if (stopped || !Array.isArray(hookRows) || !Array.isArray(memoryRows)) return;
        setHooks(hookRows.filter((row) => row.cli_found && !row.installed).map((row) => row.agent));
        setMemory(memoryRows.filter((row) => row.cli_found && row.memory_ready && !row.connected).map((row) => row.agent));
        // Memory sets itself up on first start; look again until it is ready.
        if (memoryRows.some((row) => row.cli_found && !row.memory_ready)) timer = setTimeout(poll, 10_000);
      } catch { /* not the desktop helper: show nothing */ }
    };
    void poll();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, []);

  if (hooks.length === 0 && memory.length === 0 && state !== 'done' && state !== 'failed') return null;
  const agents = joined([...hooks, ...memory]);
  const what = hooks.length && memory.length
    ? 'get notified when they finish a turn, and let them share Dolphin’s memory.'
    : hooks.length ? 'get notified when they finish a turn.' : 'let them share Dolphin’s memory, so what you tell Dolphin reaches them too.';

  const turnOn = async () => {
    setState('working');
    try {
      if (hooks.length) await request('/api/desktop/agent-hooks', { method: 'POST', body: JSON.stringify({ agents: hooks }) });
      if (memory.length) await request('/api/desktop/agent-memory', { method: 'POST', body: JSON.stringify({ agents: memory }) });
      const done = [hooks.length ? 'notifications are on' : '', memory.length ? 'they share Dolphin’s memory in new sessions' : ''].filter(Boolean).join(', and ');
      setMessage(`${agents}: ${done}.${hooks.includes('codex') ? ' Codex will ask you once to trust Dolphin’s hook; choose Trust.' : ''}`);
      setState('done');
      setHooks([]);
      setMemory([]);
    } catch (error) {
      setMessage(`Could not connect them: ${error instanceof Error ? error.message : String(error)}`);
      setState('failed');
    }
  };

  return (
    <section className="signals-tray" aria-label="Agent setup">
      {state === 'done' || state === 'failed' ? (
        <p role="status" className="signals-status agent-hooks-message">{message}</p>
      ) : (
        <div className="agent-hooks-row">
          <Sparkles size={15} aria-hidden="true" />
          <span>Connect {agents} to Dolphin: {what}</span>
          <div className="signals-actions">
            <button type="button" className="signals-primary" disabled={state === 'working'} onClick={() => void turnOn()}>Turn On</button>
            <button type="button" onClick={() => {
              try { localStorage.setItem(DISMISS_KEY, '1'); } catch { /* storage is optional */ }
              setHooks([]);
              setMemory([]);
            }}>Not Now</button>
          </div>
        </div>
      )}
    </section>
  );
}
