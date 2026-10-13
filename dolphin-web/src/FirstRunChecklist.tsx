import { useEffect, useRef, useState } from 'react';
import { Circle, CircleCheck } from 'lucide-react';
import type { AgentCli } from './api';
import { useApi } from './apiContext';
import { desktopSettingsBridge } from './desktop/bridge';
import { AGENT_SETUP_CHANGED, BRAIN_CHANGED, checklist, type BrainState, type ChecklistItem, type Environment, type HookRow } from './firstRun';
import './firstRunChecklist.css';

/* Dolphin Desktop's first run, at the top of a machine's start panel: what
   this machine has, and one click for each thing it still lacks. Nothing
   changes without that click. It looks again when the window comes back to
   the front (after an install in a terminal, say) and on Check Again. */

/** After Turn On, the choice reaches the helper through the main process a
    moment later; keep looking this long for memory to start setting up. */
const MEMORY_WATCH_MS = 30_000;

export default function FirstRunChecklist({ onInstall, onSignIn }: {
  onInstall?: (agent: AgentCli) => Promise<void> | void;
  onSignIn?: (agent: 'claude' | 'codex') => Promise<void> | void;
}) {
  const { request } = useApi();
  const [environment, setEnvironment] = useState<Environment | null>(null);
  const [agents, setAgents] = useState<AgentCli[] | null>(null);
  const [hooks, setHooks] = useState<HookRow[] | null>(null);
  const [brain, setBrain] = useState<BrainState | null>(null);
  const [round, setRound] = useState(0);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const watchUntil = useRef(0);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      const [env, clis, hookRows, brainState] = await Promise.all([
        request<Environment>('/api/desktop/environment').catch(() => null),
        request<AgentCli[]>(`/api/desktop/agents${round > 0 ? '?refresh=true' : ''}`).catch(() => null),
        request<HookRow[]>('/api/desktop/agent-hooks').catch(() => null),
        request<BrainState>('/api/brain').catch(() => null),
      ]);
      if (stopped) return;
      setEnvironment(env);
      setAgents(Array.isArray(clis) ? clis : null);
      setHooks(Array.isArray(hookRows) ? hookRows : null);
      setBrain(brainState);
      const watching = Date.now() < watchUntil.current;
      // After Turn On a failed read must not end the watch silently.
      if (!brainState && watchUntil.current > 0) setMessage('Could not read memory’s status. Press Check Again to look once more.');
      // Memory sets itself up in the background once it is on: follow it.
      const settingUp = brainState && (brainState.state === 'installing' || brainState.state === 'missing');
      const waitingForChoice = watching && (!brainState || brainState.state === 'off');
      if (settingUp || waitingForChoice) timer = setTimeout(() => void load(), 2000);
    };
    void load();
    const again = () => setRound((value) => value + 1);
    window.addEventListener('focus', again);
    return () => { stopped = true; if (timer) clearTimeout(timer); window.removeEventListener('focus', again); };
  }, [round]);

  const items = checklist({ environment, agents, hooks, brain, canChooseMemory: desktopSettingsBridge() !== undefined });
  if (items.length === 0) return null;

  const act = async (item: ChecklistItem) => {
    const action = item.action;
    if (!action) return;
    setBusy(item.id);
    setMessage('');
    try {
      if (action.kind === 'install') {
        const cli = agents?.find((row) => row.agent === action.agent);
        if (cli) await onInstall?.(cli);
      } else if (action.kind === 'sign-in') {
        await onSignIn?.(action.agent);
      } else if (action.kind === 'notifications') {
        await request('/api/desktop/agent-hooks', { method: 'POST', body: JSON.stringify({ agents: action.agents }) });
        if (action.agents.includes('codex')) setMessage('Codex will ask you once to trust Dolphin’s hook; choose Trust.');
        window.dispatchEvent(new Event(AGENT_SETUP_CHANGED));
      } else if (action.kind === 'memory') {
        // The setting is the choice for every machine: the main process tells
        // each helper (POST /api/brain/consent), so this does not call it too.
        watchUntil.current = Date.now() + MEMORY_WATCH_MS;
        await desktopSettingsBridge()?.set({ memory: true });
        window.dispatchEvent(new Event(BRAIN_CHANGED));
      } else {
        await request('/api/brain/setup', { method: 'POST' });
        window.dispatchEvent(new Event(BRAIN_CHANGED));
      }
    } catch (error) {
      setMessage(`${item.label}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy('');
      setRound((value) => value + 1);
    }
  };

  return (
    <section className="first-run" aria-label="Setup checklist">
      <h3>Set up</h3>
      <ul>
        {items.map((item) => (
          <li key={item.id} className={item.done ? 'first-run-item is-done' : 'first-run-item'}>
            {item.done ? <CircleCheck size={14} aria-label="Done" /> : <Circle size={14} aria-label="To do" />}
            <span><strong>{item.label}</strong><small title={item.detail}>{item.detail}</small></span>
            {item.action && (
              <button type="button" aria-label={item.action.name} disabled={busy !== ''} onClick={() => void act(item)}>
                {busy === item.id ? '…' : item.action.label}
              </button>
            )}
          </li>
        ))}
      </ul>
      {message && <p role="status">{message}</p>}
      <button type="button" className="first-run-again" onClick={() => setRound((value) => value + 1)}>Check Again</button>
    </section>
  );
}
