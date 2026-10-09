// MUST be the first import: stylesheet load order (see src/styles/index.ts).
import '../styles';

import React from 'react';
import ReactDOM from 'react-dom/client';
import { ArrowLeft } from 'lucide-react';

import DictationProvider from '../DictationProvider';
import DolphinIcon from '../DolphinIcon';
import ErrorBoundary from '../ErrorBoundary';
import { applyTheme, readStoredTheme } from '../theme';
import '../glass.css';
import './glassHealth.css';
import './desktop.css';

const GlassWorkspace = React.lazy(() => import('../GlassWorkspace'));
const SystemHealthView = React.lazy(() => import('../SystemHealthView'));

type Surface = 'workspace' | 'health';
/** The machine this window works on (the preload hands it over). */
const host = (window as { dolphinDesktop?: { config?: { host?: string } } }).dolphinDesktop?.config?.host;
const surfaceOf = (hash: string): Surface => (hash === '#/health' ? 'health' : 'workspace');

/* Dolphin Desktop shows two surfaces: the workspace, and System Health for the
   machine this window is connected to. Nothing else from the web app ships. */
function DesktopRouter() {
  const [surface, setSurface] = React.useState<Surface>(() => surfaceOf(window.location.hash));
  React.useEffect(() => {
    const changed = () => setSurface(surfaceOf(window.location.hash));
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, []);
  return (
    <React.Suspense fallback={<p className="desktop-loading">Opening Dolphin…</p>}>
      {surface === 'health' ? (
        <div className="glass-health">
          <header className="glass-health-top">
            <a className="glass-brand" href="#/workspace" aria-label="Dolphin workspace">
              <span className="dolphin-mark"><DolphinIcon /></span>
              Dolphin
            </a>
            {host && <span className="glass-host" title={`Working on ${host}`}>{host}</span>}
            <span className="glass-health-crumb">System Health</span>
            <a className="glass-health-back" href="#/workspace">
              <ArrowLeft size={15} aria-hidden="true" /> Back to Workspace
            </a>
          </header>
          <main className="glass-health-stage">
            <SystemHealthView />
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
