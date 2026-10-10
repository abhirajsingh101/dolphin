import { useEffect, useRef, useState } from 'react';
import { ChevronDown, KeyRound, Laptop, Plus, RefreshCw, Server } from 'lucide-react';
import { machineBridge, type Link, type Machine } from './machines';
import './connectMachine.css';

/* The machine this window works on, in the header: its name and whether the
   link is up. Opens a menu to switch machines, connect a new one, reconnect,
   or set up sign-in without a password. */

const STATUS: Record<Link['state'], string> = {
  connecting: 'Connecting…',
  connected: 'Connected',
  reconnecting: 'Reconnecting…',
  offline: 'Disconnected',
};

export default function MachineSwitcher({ label, onConnect }: { label: string; onConnect: () => void }) {
  const [link, setLink] = useState<Link | null>(() => machineBridge()?.connection?.() ?? null);
  const [open, setOpen] = useState(false);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [key, setKey] = useState<'idle' | 'working' | 'done' | string>('idle');
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => machineBridge()?.onConnection?.(setLink) ?? undefined, []);
  useEffect(() => {
    if (!open) return;
    machineBridge()?.machines?.().then((found) => setMachines(found.filter((machine) => machine.source === 'recent').slice(0, 5)), () => undefined);
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', close);
    document.addEventListener('pointerdown', close);
    return () => {
      document.removeEventListener('keydown', close);
      document.removeEventListener('pointerdown', close);
    };
  }, [open]);

  const state = link?.state ?? 'connected';
  const remote = link?.kind === 'ssh';
  const here = link?.target ?? 'local';
  const others = [
    ...(remote ? [{ target: 'local', label: 'This Computer', source: 'recent' as const }] : []),
    ...machines.filter((machine) => machine.target !== here),
  ];
  const setUpKey = async () => {
    setKey('working');
    const result = await machineBridge()?.setupKey?.();
    setKey(result?.error ? result.error : 'done');
  };

  return (
    <div className="machine-switcher" ref={root}>
      <button
        type="button"
        className="glass-host machine-chip"
        data-state={state}
        aria-label={`Machine: ${label}, ${STATUS[state].replace('…', '')}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`${remote ? 'Working over SSH on' : 'Working on'} ${label} · ${STATUS[state]}`}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="machine-chip-label">{state === 'reconnecting' || state === 'offline' ? STATUS[state] : label}</span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      {open && (
        <div className="machine-menu" role="menu" aria-label="Machines">
          <div className="machine-current">
            {remote ? <Server size={16} aria-hidden="true" /> : <Laptop size={16} aria-hidden="true" />}
            <span>
              <strong>{label}</strong>
              <small data-state={state}>{remote ? `${STATUS[state]} over SSH` : 'This computer'}{link?.reason && state !== 'connected' ? ` · ${link.reason}` : ''}</small>
            </span>
            {remote && state !== 'connected' && (
              <button type="button" role="menuitem" className="machine-action" onClick={() => machineBridge()?.reconnect?.()}>
                <RefreshCw size={13} aria-hidden="true" /> Reconnect
              </button>
            )}
          </div>
          {remote && link?.offerKey && key !== 'done' && (
            <div className="machine-key">
              <KeyRound size={15} aria-hidden="true" />
              <span>
                <strong>Skip the password next time</strong>
                <small>{key !== 'idle' && key !== 'working' ? `Could not set it up: ${key}` : `Adds a key for Dolphin to ${label}, so it reconnects by itself.`}</small>
              </span>
              <button type="button" role="menuitem" className="machine-action" disabled={key === 'working'} onClick={() => void setUpKey()}>
                {key === 'working' ? 'Setting up…' : 'Set Up'}
              </button>
            </div>
          )}
          {key === 'done' && <p className="machine-note" role="status">Done. {label} signs you in with Dolphin's key from now on.</p>}
          {others.length > 0 && (
            <>
              <p className="machine-group">Switch to</p>
              {others.map((machine) => (
                <button key={machine.target} type="button" role="menuitem" className="machine-item"
                  onClick={() => { setOpen(false); void machineBridge()?.openMachine?.(machine.target); }}>
                  {machine.target === 'local' ? <Laptop size={15} aria-hidden="true" /> : <Server size={15} aria-hidden="true" />}
                  <span>{machine.label}</span>
                  {machine.open && <em>Open</em>}
                </button>
              ))}
            </>
          )}
          <button type="button" role="menuitem" className="machine-item machine-connect" onClick={() => { setOpen(false); onConnect(); }}>
            <Plus size={15} aria-hidden="true" />
            <span>Connect to a Machine…</span>
          </button>
        </div>
      )}
    </div>
  );
}
