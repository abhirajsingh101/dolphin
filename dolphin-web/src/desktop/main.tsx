// MUST be the first import: stylesheet load order (see src/styles/index.ts).
import '../styles';

import React from 'react';
import ReactDOM from 'react-dom/client';

import DictationProvider from '../DictationProvider';
import DolphinIcon from '../DolphinIcon';
import ErrorBoundary from '../ErrorBoundary';
import { applyTheme, readStoredTheme } from '../theme';
import { useMachineLinks } from '../machines';
import { healthTarget } from './healthTarget';
import '../glass.css';
import './glassHealth.css';
import './glassDialogs.css';
import './desktop.css';
import './motion.css';

const GlassWorkspace = React.lazy(() => import('../GlassWorkspace'));
const HealthOverlay = React.lazy(() => import('./HealthOverlay'));

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

/* Dolphin Desktop shows the workspace, always, and System Health for one of
   its machines as an overlay over it (`#/health/<id>`; this computer without one). */
function DesktopRouter() {
  const [surface, setSurface] = React.useState<Surface>(() => surfaceOf(window.location.hash));
  const links = useMachineLinks(true);
  React.useEffect(() => {
    const changed = () => setSurface(surfaceOf(window.location.hash));
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, []);
  return (
    <>
      <React.Suspense fallback={<DesktopSplash />}>
        <GlassWorkspace desktop />
      </React.Suspense>
      {surface.kind === 'health' && (
        <React.Suspense fallback={null}>
          <HealthOverlay machine={surface.machine} target={healthTarget(surface.machine, links, host)} />
        </React.Suspense>
      )}
    </>
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
