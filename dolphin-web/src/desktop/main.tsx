// MUST be the first import: stylesheet load order (see src/styles/index.ts).
import '../styles';

import React from 'react';
import ReactDOM from 'react-dom/client';
import { ArrowLeft } from 'lucide-react';

import DictationProvider from '../DictationProvider';
import ErrorBoundary from '../ErrorBoundary';
import { applyTheme, readStoredTheme } from '../theme';
import './desktop.css';

const GlassWorkspace = React.lazy(() => import('../GlassWorkspace'));
const SystemHealthView = React.lazy(() => import('../SystemHealthView'));

type Surface = 'workspace' | 'health';
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
        <div className="desktop-health">
          <nav className="desktop-health-bar" aria-label="System Health">
            <a href="#/workspace"><ArrowLeft size={16} aria-hidden="true" /> Back to Workspace</a>
          </nav>
          <SystemHealthView />
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
