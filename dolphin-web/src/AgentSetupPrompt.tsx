import { useEffect, useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';
import type { Api } from './api';
import { AGENT_SETUP_CHANGED, BRAIN_CHANGED, memoryStillSettingUp } from './firstRun';
import { dismissKey, doneMessage, offerFor, type HookRow, type MemoryRow, type SetupOffer } from './agentSetupModel';
import './composerNotice.css';

/* Dolphin Desktop: one line per machine above the composer, offering what
   that machine's agents still need (agentSetupModel.ts). Turn On changes that
   machine only; nothing changes without the click. Not Now is remembered per
   machine. */

export type SetupSource = { id: string; label?: string; api: Api };
type Result = { state: 'working' | 'done' | 'failed'; message: string };

const dismissed = (machine: string) => { try { return localStorage.getItem(dismissKey(machine)) === '1'; } catch { return false; } };
export default function AgentSetupPrompt({ sources, onHolding }: {
  sources: SetupSource[];
  /** The machines whose setup is still being looked at, or offered and not answered:
   * a modal over them would cover the click they need. */
  onHolding?: (machines: string[]) => void;
}) {
  const [offers, setOffers] = useState<Record<string, SetupOffer>>({});
  const [settled, setSettled] = useState<string[]>([]);
  const settle = (machine: string, done: boolean) => setSettled((all) => {
    const has = all.includes(machine);
    if (done === has) return all;
    return done ? [...all, machine] : all.filter((id) => id !== machine);
  });
  const [results, setResults] = useState<Record<string, Result>>({});
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;
  const [round, setRound] = useState(0);
  // The first-run checklist turned notifications or memory on: look again.
  useEffect(() => {
    const again = () => setRound((value) => value + 1);
    window.addEventListener(AGENT_SETUP_CHANGED, again);
    window.addEventListener(BRAIN_CHANGED, again);
    return () => { window.removeEventListener(AGENT_SETUP_CHANGED, again); window.removeEventListener(BRAIN_CHANGED, again); };
  }, []);
  const sourcesKey = sources.map((source) => `${source.id} ${source.api.API_BASE} ${source.api.API_TOKEN}`).join('|');
  const setOffer = (machine: string, offer: SetupOffer | null) => setOffers((all) => {
    const next = { ...all };
    if (offer) next[machine] = offer; else delete next[machine];
    return next;
  });

  useEffect(() => {
    let stopped = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const poll = async (source: SetupSource) => {
      if (dismissed(source.id)) { settle(source.id, true); return; }
      try {
        const [hookRows, memoryRows] = await Promise.all([
          source.api.request<HookRow[]>('/api/desktop/agent-hooks'),
          source.label ? Promise.resolve([] as MemoryRow[]) : source.api.request<MemoryRow[]>('/api/desktop/agent-memory'),
        ]);
        if (stopped || !Array.isArray(hookRows) || !Array.isArray(memoryRows)) return;
        setOffer(source.id, offerFor(source.id, source.label, hookRows, memoryRows));
        // Once memory is on it sets itself up; look again until it is ready.
        const waiting = !source.label && memoryStillSettingUp(memoryRows);
        if (waiting) timers.push(setTimeout(() => void poll(source), 10_000));
        // Memory is still setting up: an offer may yet appear, so the machine stays held.
        else settle(source.id, true);
      } catch { settle(source.id, true); /* an older helper, or not reachable now: offer nothing */ }
    };
    sourcesRef.current.forEach((source) => void poll(source));
    return () => { stopped = true; timers.forEach(clearTimeout); };
  }, [sourcesKey, round]);

  const holding = sources.filter((source) => !settled.includes(source.id) || offers[source.id]).map((source) => source.id);
  const holdingKey = holding.join('|');
  const report = useRef(onHolding);
  report.current = onHolding;
  useEffect(() => { report.current?.(holdingKey ? holdingKey.split('|') : []); }, [holdingKey]);

  const turnOn = async (offer: SetupOffer) => {
    const source = sourcesRef.current.find((item) => item.id === offer.machine);
    if (!source) return;
    setResults((all) => ({ ...all, [offer.machine]: { state: 'working', message: '' } }));
    try {
      if (offer.hooks.length) await source.api.request('/api/desktop/agent-hooks', { method: 'POST', body: JSON.stringify({ agents: offer.hooks }) });
      if (offer.memory.length) await source.api.request('/api/desktop/agent-memory', { method: 'POST', body: JSON.stringify({ agents: offer.memory }) });
      setResults((all) => ({ ...all, [offer.machine]: { state: 'done', message: doneMessage(offer) } }));
      setOffer(offer.machine, null);
    } catch (error) {
      setResults((all) => ({ ...all, [offer.machine]: { state: 'failed',
        message: `Could not connect them${offer.label ? ` on ${offer.label}` : ''}: ${error instanceof Error ? error.message : String(error)}` } }));
    }
  };

  const shown = sources.flatMap((source) => (offers[source.id] ? [offers[source.id]] : []));
  const messages = sources.flatMap((source) => {
    const result = results[source.id];
    return result && result.state !== 'working' ? [{ id: source.id, message: result.message }] : [];
  });
  if (!shown.length && !messages.length) return null;
  return (
    <section className="signals-tray" aria-label="Agent setup">
      {messages.map((item) => <p key={`result ${item.id}`} role="status" className="signals-status agent-hooks-message">{item.message}</p>)}
      {shown.map((offer) => (
        <div className="agent-hooks-row" key={offer.machine}>
          <Sparkles size={15} aria-hidden="true" />
          <span>{offer.text}</span>
          <div className="signals-actions">
            <button type="button" className="signals-primary" aria-label={offer.action} disabled={results[offer.machine]?.state === 'working'} onClick={() => void turnOn(offer)}>Turn On</button>
            <button type="button" aria-label={offer.label ? `Not now for ${offer.label}` : 'Not Now'} onClick={() => {
              try { localStorage.setItem(dismissKey(offer.machine), '1'); } catch { /* storage is optional */ }
              setOffer(offer.machine, null);
            }}>Not Now</button>
          </div>
        </div>
      ))}
    </section>
  );
}
