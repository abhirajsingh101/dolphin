import { Suspense, lazy, useEffect, useRef } from 'react';
import { ArrowLeft } from 'lucide-react';

import { api, apiFor } from '../api';
import { ApiContext } from '../apiContext';
import DolphinIcon from '../DolphinIcon';
import type { HealthTarget } from './healthTarget';

const SystemHealthView = lazy(() => import('../SystemHealthView'));

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/* System Health over the workspace, which stays mounted (and inert) beneath
   it, so its terminals keep their connections. Escape or Back returns, and
   focus goes back to where it was. Closing unmounts the view, which stops its
   polling; the view also pauses while the window is hidden. */
export default function HealthOverlay({ machine, target }: { machine: string; target: HealthTarget }) {
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
  return (
    <div ref={root} className="glass-health" role="dialog" aria-modal="true" aria-label="System Health" onKeyDown={keys}>
      <header className="glass-health-top">
        <a className="glass-brand" href="#/workspace" aria-label="Dolphin workspace"><span className="dolphin-mark"><DolphinIcon /></span></a>
        {target.label && <span className="glass-host" data-state={target.kind === 'unavailable' ? 'offline' : undefined} title={target.kind === 'unavailable' ? `${target.label} is not connected` : `Health of ${target.label}`}>{target.label}</span>}
        <a ref={back} className="glass-health-back" href="#/workspace"><ArrowLeft size={15} aria-hidden="true" /> Back to Workspace</a>
      </header>
      <main className="glass-health-stage">
        {target.kind === 'unavailable' ? (
          <div className="glass-health-unavailable" role="status">
            <p><strong>{target.label} is not connected.</strong></p>
            <p>Its health shows here once it reconnects. Reconnect it from the projects list.</p>
          </div>
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
