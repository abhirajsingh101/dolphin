import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Activity, ChevronDown, FileText, Gauge, KeyRound, LoaderCircle, MoreHorizontal, Network, Plus, RefreshCw, Server, Unplug } from 'lucide-react';
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

/** Under the button when it fits, above it when it does not, always inside the window. */
export function placeMachineMenu(
  anchor: { top: number; bottom: number; right: number },
  menu: { width: number; height: number },
  view: { width: number; height: number },
) {
  const left = Math.max(16, Math.min(anchor.right - menu.width, view.width - menu.width - 16));
  const below = anchor.bottom + 6;
  const top = below + menu.height <= view.height - 16 ? below : anchor.top - 6 - menu.height;
  return { top: Math.max(16, Math.min(top, view.height - menu.height - 16)), left };
}

export type WorkflowPanelKind = 'ports' | 'usage';

export default function MachineSection({ link, count, collapsed, onToggle, onAddProject, onOpenPanel, children }: {
  link: MachineLink;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  onAddProject: () => void;
  onOpenPanel?: (panel: WorkflowPanelKind) => void;
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
          <ChevronDown size={12} aria-hidden="true" />
          <i className="glass-machine-dot" data-state={link.state} aria-hidden="true" />
          <strong className="glass-machine-label">{label}</strong>
          {!connected && (
            <small data-state={link.state}>
              {(link.state === 'connecting' || link.state === 'reconnecting') && <LoaderCircle size={11} aria-hidden="true" />}
              {machineStatus(link)}
            </small>
          )}
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
        {(remote || (onOpenPanel && machineBridge()?.openPort)) && <MachineMenu link={link} onOpenPanel={onOpenPanel} />}
      </div>
      {problem && !collapsed && (
        <div className="glass-machine-problem" role="alert">
          <p>{link.state === 'failed' ? link.error || `Dolphin couldn't reach ${label}.` : `The link to ${label} dropped${link.reason ? `: ${link.reason}` : '.'} Your sessions there keep running.`}</p>
          <div>
            <button type="button" className="machine-action" onClick={() => machineBridge()?.reconnect?.(link.target ?? link.id)}>
              <RefreshCw size={13} aria-hidden="true" /> Reconnect
            </button>
            {remote && link.state === 'failed' && (
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

function MachineMenu({ link, onOpenPanel }: { link: MachineLink; onOpenPanel?: (panel: WorkflowPanelKind) => void }) {
  const remote = link.kind === 'ssh';
  // Ports and Usage both need a live link and the desktop bridge (the endpoints exist only in helper mode).
  const canOpenPanels = link.state === 'connected' && onOpenPanel && machineBridge()?.openPort ? onOpenPanel : null;
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState<'idle' | 'working' | 'done' | string>('idle');
  const [logError, setLogError] = useState('');
  const showLog = async () => {
    setLogError('');
    const result = await machineBridge()?.remoteLog?.(target);
    if (result?.error) setLogError(result.error);
    else setOpen(false);
  };
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
    const height = menu.current?.offsetHeight ?? 0;
    setPlace(placeMachineMenu(box, { width, height }, { width: window.innerWidth, height: window.innerHeight }));
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
          {remote && (
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
          )}
          {remote && link.offerKey && key !== 'done' && (
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
          {remote && key === 'done' && <p className="machine-note" role="status">Done. {link.label} signs you in with Dolphin's key from now on.</p>}
          {canOpenPanels && (
            <>
              <button type="button" role="menuitem" className="machine-item" onClick={() => { setOpen(false); canOpenPanels('ports'); }}>
                <Network size={15} aria-hidden="true" />
                <span>Ports…</span>
              </button>
              <button type="button" role="menuitem" className="machine-item" onClick={() => { setOpen(false); canOpenPanels('usage'); }}>
                <Gauge size={15} aria-hidden="true" />
                <span>Usage…</span>
              </button>
            </>
          )}
          {remote && link.state === 'connected' && (
            <a role="menuitem" className="machine-item" href={`#/health/${encodeURIComponent(link.id)}`} onClick={() => setOpen(false)}>
              <Activity size={15} aria-hidden="true" />
              <span>System Health</span>
            </a>
          )}
          {remote && (
            <button type="button" role="menuitem" className="machine-item" onClick={() => void showLog()}>
              <FileText size={15} aria-hidden="true" />
              <span>Show Remote Log</span>
            </button>
          )}
          {remote && logError && <p className="machine-note" role="alert">{logError}</p>}
          {remote && link.state === 'connected' && (
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={Boolean(link.agentForwarding)}
              className="machine-item"
              onClick={() => void machineBridge()?.setAgentForwarding?.(target, !link.agentForwarding)}
            >
              <KeyRound size={15} aria-hidden="true" />
              <span>
                Forward SSH agent
                <small>{link.agentError
                  ? link.agentError
                  : link.agentForwarding
                    ? `New sessions on ${link.label} can use this computer's SSH keys.`
                    : `Off. Turn on so git push from sessions on ${link.label} uses this computer's keys.`}</small>
              </span>
            </button>
          )}
          {remote && (
            <button type="button" role="menuitem" className="machine-item" onClick={() => { setOpen(false); machineBridge()?.closeMachine?.(target); }}>
              <Unplug size={15} aria-hidden="true" />
              <span>Disconnect</span>
            </button>
          )}
        </div>,
        root.current?.closest('.glass-workspace') ?? document.body,
      )}
    </div>
  );
}
