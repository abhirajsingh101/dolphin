import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Activity, ChevronDown, KeyRound, Laptop, LoaderCircle, MoreHorizontal, Plus, RefreshCw, Server, Unplug } from 'lucide-react';
import { machineBridge, type MachineLink } from './machines';
import './connectMachine.css';

/* One machine in the projects list: a heading with its name and whether its
   link is up, then its projects. This computer comes first; every machine
   added from Connect to a Machine follows, each with a menu to reconnect, set
   up sign-in without a password, or disconnect. */

const STATE: Record<MachineLink['state'], string> = {
  connecting: 'Connecting…',
  connected: 'Connected',
  reconnecting: 'Reconnecting…',
  offline: 'Disconnected',
  failed: "Couldn't connect",
};

export function machineStatus(link: MachineLink): string {
  if (link.kind === 'local') return link.hostname ?? 'This computer';
  if (link.state === 'connecting' && link.status) return link.status;
  return STATE[link.state];
}

export default function MachineSection({ link, count, collapsed, onToggle, onAddProject, children }: {
  link: MachineLink;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  onAddProject: () => void;
  children: ReactNode;
}) {
  const remote = link.kind === 'ssh';
  const connected = link.state === 'connected';
  const problem = link.state === 'failed' || link.state === 'offline';
  const label = link.label;
  return (
    <section className="glass-machine" data-machine={link.id} data-kind={link.kind} data-state={link.state} aria-label={`${label} projects`}>
      <div className="glass-machine-head">
        <button
          type="button"
          className="glass-machine-toggle"
          aria-expanded={!collapsed}
          aria-label={`${label}, ${machineStatus(link)}, ${count} ${count === 1 ? 'project' : 'projects'}`}
          title={remote ? `${label} over SSH · ${machineStatus(link)}` : `This computer (${link.hostname ?? 'local'})`}
          onClick={onToggle}
        >
          <ChevronDown size={13} aria-hidden="true" />
          <span className="glass-machine-icon" aria-hidden="true">{remote ? <Server size={14} /> : <Laptop size={14} />}</span>
          <span className="glass-machine-name">
            <strong>{label}</strong>
            <small data-state={link.state}>
              {(link.state === 'connecting' || link.state === 'reconnecting') && <LoaderCircle size={11} aria-hidden="true" />}
              {machineStatus(link)}
            </small>
          </span>
        </button>
        <button
          type="button"
          className="glass-machine-add"
          aria-label={`Add a project on ${label}`}
          title={`Open a folder on ${label} as a project`}
          disabled={!connected}
          onClick={onAddProject}
        >
          <Plus size={15} />
        </button>
        {remote && <MachineMenu link={link} />}
      </div>
      {problem && !collapsed && (
        <div className="glass-machine-problem" role="alert">
          <p>{link.state === 'failed' ? link.error || `Dolphin couldn't reach ${label}.` : `The link to ${label} dropped${link.reason ? `: ${link.reason}` : '.'} Your sessions there keep running.`}</p>
          <div>
            <button type="button" className="machine-action" onClick={() => link.target && machineBridge()?.reconnect?.(link.target)}>
              <RefreshCw size={13} aria-hidden="true" /> Reconnect
            </button>
            {link.state === 'failed' && (
              <button type="button" className="glass-machine-dismiss" onClick={() => link.target && machineBridge()?.closeMachine?.(link.target)}>
                Remove
              </button>
            )}
          </div>
        </div>
      )}
      {!collapsed && children}
    </section>
  );
}

function MachineMenu({ link }: { link: MachineLink }) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState<'idle' | 'working' | 'done' | string>('idle');
  const root = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState({ top: 0, left: 0 });
  const target = link.target ?? '';
  // The projects list scrolls and clips, so the menu sits in a layer above
  // it, under its button, kept inside the window.
  useLayoutEffect(() => {
    if (!open) return;
    const box = root.current?.getBoundingClientRect();
    if (!box) return;
    const width = Math.min(320, window.innerWidth - 32);
    setPlace({ top: box.bottom + 6, left: Math.max(16, Math.min(box.right - width, window.innerWidth - width - 16)) });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      const inside = root.current?.contains(event.target as Node) || menu.current?.contains(event.target as Node);
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !inside) setOpen(false);
    };
    document.addEventListener('keydown', close);
    document.addEventListener('pointerdown', close);
    return () => {
      document.removeEventListener('keydown', close);
      document.removeEventListener('pointerdown', close);
    };
  }, [open]);
  const setUpKey = async () => {
    setKey('working');
    const result = await machineBridge()?.setupKey?.(target);
    setKey(result?.error ? result.error : 'done');
  };
  return (
    <div className="machine-switcher" ref={root}>
      <button
        type="button"
        className="glass-machine-more"
        aria-label={`${link.label} options`}
        aria-haspopup="menu"
        aria-expanded={open}
        data-attention={link.offerKey || undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <MoreHorizontal size={15} />
      </button>
      {open && createPortal(
        <div ref={menu} className="machine-menu machine-menu--end" role="menu" aria-label={`${link.label} options`} style={{ top: place.top, left: place.left }}>
          <div className="machine-current">
            <Server size={16} aria-hidden="true" />
            <span>
              <strong>{link.label}</strong>
              <small data-state={link.state}>{STATE[link.state]} over SSH{link.reason && link.state !== 'connected' ? ` · ${link.reason}` : ''}</small>
            </span>
            {link.state !== 'connected' && (
              <button type="button" role="menuitem" className="machine-action" onClick={() => { setOpen(false); machineBridge()?.reconnect?.(target); }}>
                <RefreshCw size={13} aria-hidden="true" /> Reconnect
              </button>
            )}
          </div>
          {link.offerKey && key !== 'done' && (
            <div className="machine-key">
              <KeyRound size={15} aria-hidden="true" />
              <span>
                <strong>Skip the password next time</strong>
                <small>{key !== 'idle' && key !== 'working' ? `Could not set it up: ${key}` : `Adds a key for Dolphin to ${link.label}, so it reconnects by itself.`}</small>
              </span>
              <button type="button" role="menuitem" className="machine-action" disabled={key === 'working'} onClick={() => void setUpKey()}>
                {key === 'working' ? 'Setting up…' : 'Set Up'}
              </button>
            </div>
          )}
          {key === 'done' && <p className="machine-note" role="status">Done. {link.label} signs you in with Dolphin's key from now on.</p>}
          {link.state === 'connected' && (
            <a role="menuitem" className="machine-item" href={`#/health/${encodeURIComponent(link.id)}`} onClick={() => setOpen(false)}>
              <Activity size={15} aria-hidden="true" />
              <span>System Health</span>
            </a>
          )}
          <button type="button" role="menuitem" className="machine-item" onClick={() => { setOpen(false); machineBridge()?.closeMachine?.(target); }}>
            <Unplug size={15} aria-hidden="true" />
            <span>Disconnect</span>
          </button>
        </div>,
        root.current?.closest('.glass-workspace') ?? document.body,
      )}
    </div>
  );
}
