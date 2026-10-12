// MUST be the first import: stylesheet load order (see src/styles/index.ts).
import '../styles';

import React from 'react';
import ReactDOM from 'react-dom/client';
import { ArrowLeft } from 'lucide-react';

import DictationProvider from '../DictationProvider';
import DolphinIcon from '../DolphinIcon';
import ErrorBoundary from '../ErrorBoundary';
import { applyTheme, readStoredTheme } from '../theme';
import { api, apiFor } from '../api';
import { ApiContext } from '../apiContext';
import { useMachineLinks } from '../machines';
import '../glass.css';
import './glassHealth.css';
import './glassDialogs.css';
import './desktop.css';
import './motion.css';

const GlassWorkspace = React.lazy(() => import('../GlassWorkspace'));
const SystemHealthView = React.lazy(() => import('../SystemHealthView'));

/** The workspace, or System Health for one machine (`#/health/<id>`; this computer without one). */
type Surface = { kind: 'workspace' } | { kind: 'health'; machine: string };
/** This computer's name (the preload hands it over). */
const host = (window as { dolphinDesktop?: { config?: { host?: string } } }).dolphinDesktop?.config?.host;
const surfaceOf = (hash: string): Surface => {
  const health = /^#\/health(?:\/(.+))?$/.exec(hash);
  return health ? { kind: 'health', machine: health[1] ? decodeURIComponent(health[1]) : 'local' } : { kind: 'workspace' };
};

/** While a surface loads: the launch page's breathing mark and sweeping bar. */
function DesktopSplash() {
  return (
    <div className="desktop-splash" role="status" aria-live="polite">
      <span className="dolphin-orb"><DolphinIcon /></span>
      <p>Opening Dolphin…</p>
      <span className="desktop-splash-bar" aria-hidden="true" />
    </div>
  );
}

/* Dolphin Desktop shows two surfaces: the workspace, and System Health for one
   of the machines in it. Nothing else from the web app ships. */
function DesktopRouter() {
  const [surface, setSurface] = React.useState<Surface>(() => surfaceOf(window.location.hash));
  const links = useMachineLinks(true);
  const machine = surface.kind === 'health' && surface.machine !== 'local' ? links.find((link) => link.id === surface.machine) : undefined;
  const healthApi = machine?.apiBase && machine.token !== null ? apiFor({ base: machine.apiBase, token: machine.token }) : api;
  const healthHost = surface.kind === 'health' && surface.machine !== 'local' ? machine?.label ?? surface.machine : host;
  React.useEffect(() => {
    const changed = () => setSurface(surfaceOf(window.location.hash));
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, []);
  return (
    <React.Suspense fallback={<DesktopSplash />}>
      {surface.kind === 'health' ? (
        <div className="glass-health">
          <header className="glass-health-top">
            <a className="glass-brand" href="#/workspace" aria-label="Dolphin workspace">
              <span className="dolphin-mark"><DolphinIcon /></span>
              Dolphin
            </a>
            {healthHost && <span className="glass-host" title={`Health of ${healthHost}`}>{healthHost}</span>}
            <span className="glass-health-crumb">System Health</span>
            <a className="glass-health-back" href="#/workspace">
              <ArrowLeft size={15} aria-hidden="true" /> Back to Workspace
            </a>
          </header>
          <main className="glass-health-stage">
            <ApiContext.Provider value={healthApi}>
              <SystemHealthView key={surface.machine} />
            </ApiContext.Provider>
          </main>
        </div>
      ) : (
        <GlassWorkspace desktop />
      )}
    </React.Suspense>
  );
}

applyTheme(readStoredTheme());

// The window has no separate title bar; desktop.css lays each page's header out
// around this platform's window controls and makes it the drag area.
const bridge = (window as { dolphinDesktop?: { platform?: string; onFullscreen?: (listener: (on: boolean) => void) => void } }).dolphinDesktop;
if (bridge?.platform) document.documentElement.dataset.platform = bridge.platform;
bridge?.onFullscreen?.((on) => {
  if (on) document.documentElement.dataset.fullscreen = '';
  else delete document.documentElement.dataset.fullscreen;
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary label="Dolphin">
      <DictationProvider>
        <DesktopRouter />
      </DictationProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
