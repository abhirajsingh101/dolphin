import { Suspense, lazy, useEffect, useRef } from 'react';
import { ArrowLeft, LoaderCircle, RefreshCw } from 'lucide-react';

import { api, apiFor } from '../api';
import { ApiContext } from '../apiContext';
import DolphinIcon from '../DolphinIcon';
import { machineBridge } from '../machines';
import HealthMachineSwitcher from './HealthMachineSwitcher';
import type { HealthMachine, HealthTarget } from './healthTarget';

const SystemHealthView = lazy(() => import('../SystemHealthView'));

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** What System Health says for a machine it cannot read right now, and the way to fix it. */
function Unavailable({ target }: { target: Extract<HealthTarget, { kind: 'unavailable' }> }) {
  const { label, state, detail, reconnect } = target;
  const waiting = state === 'connecting' || state === 'reconnecting';
  const title = waiting ? `Connecting to ${label}…`
    : state === 'offline' ? `${label} is disconnected.`
      : state === 'failed' ? `Couldn't connect to ${label}.`
        : `${label} is not connected.`;
  const body = waiting ? 'Its health shows here as soon as the link is up.'
    : state === 'offline' ? 'Your sessions there keep running. Reconnect to see its health.'
      : state === 'failed' ? 'Check that it is on and reachable, then try again.'
        : 'Connect it from the projects list, and its health shows here.';
  return (
    <div className="glass-health-unavailable health-machine-state" data-state={state} role="status" aria-live="polite">
      {waiting && <LoaderCircle size={22} aria-hidden="true" className="health-machine-spin" />}
      <p><strong>{title}</strong></p>
      {detail && <p className="health-machine-detail">{detail}</p>}
      <p>{body}</p>
      {reconnect && machineBridge()?.reconnect && (
        <button type="button" className="health-machine-reconnect" onClick={() => machineBridge()?.reconnect?.(reconnect)}>
          <RefreshCw size={14} aria-hidden="true" /> Reconnect
        </button>
      )}
    </div>
  );
}

/* System Health over the workspace, which stays mounted (and inert) beneath
   it, so its terminals keep their connections. Escape or Back returns, and
   focus goes back to where it was. Closing unmounts the view, which stops its
   polling; the view also pauses while the window is hidden. The header's
   machine menu switches machines in place: the overlay stays, and the view
   inside it remounts against that machine's helper. */
export default function HealthOverlay({ machine, target, machines }: { machine: string; target: HealthTarget; machines: HealthMachine[] }) {
  const root = useRef<HTMLDivElement>(null);
  const back = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const workspace = document.querySelector('.glass-workspace');
    workspace?.setAttribute('inert', '');
    back.current?.focus();
    return () => {
      workspace?.removeAttribute('inert');
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  const keys = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); window.location.hash = '#/workspace'; return; }
    if (event.key !== 'Tab') return;
    const items = [...(root.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter((item) => item.offsetParent !== null);
    if (items.length === 0) { event.preventDefault(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    const at = document.activeElement;
    if (event.shiftKey && (at === first || !root.current?.contains(at))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (at === last || !root.current?.contains(at))) { event.preventDefault(); first.focus(); }
  };
  const label = machines.find((item) => item.current)?.label ?? target.label;
  return (
    <div ref={root} className="glass-health" role="dialog" aria-modal="true" aria-label={label ? `System Health of ${label}` : 'System Health'} onKeyDown={keys}>
      <header className="glass-health-top">
        <a className="glass-brand" href="#/workspace" aria-label="Dolphin workspace"><span className="dolphin-mark"><DolphinIcon /></span></a>
        <HealthMachineSwitcher machines={machines} />
        <a ref={back} className="glass-health-back" href="#/workspace" aria-label="Back to Workspace"><ArrowLeft size={15} aria-hidden="true" /> <span className="glass-health-back-label">Back to Workspace</span></a>
      </header>
      <main className="glass-health-stage">
        {target.kind === 'unavailable' ? (
          <Unavailable target={target} />
        ) : (
          <ApiContext.Provider value={target.kind === 'remote' ? apiFor({ base: target.base, token: target.token }) : api}>
            <Suspense fallback={<p className="glass-health-unavailable" role="status">Loading System Health…</p>}>
              <SystemHealthView key={`${machine}:${target.kind === 'remote' ? target.base : ''}`} />
            </Suspense>
          </ApiContext.Provider>
        )}
      </main>
    </div>
  );
}
