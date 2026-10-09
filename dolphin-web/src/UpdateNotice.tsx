import { useEffect, useState } from 'react';
import { ArrowDownToLine } from 'lucide-react';
import './composerNotice.css';

/* Dolphin Desktop: a newer version is out. On an AppImage it downloads by
   itself and this line offers the restart; elsewhere it offers the installer.
   "Later" hides one version until the next release. */

type UpdateState =
  | { state: 'idle' | 'checking' | 'current' }
  | { state: 'available'; version: string; action: 'download'; url: string }
  | { state: 'downloading'; version: string; percent: number }
  | { state: 'ready'; version: string; action: 'restart' }
  | { state: 'error'; message: string };

type Bridge = { update?: () => UpdateState; onUpdate?: (listener: (state: UpdateState) => void) => void; applyUpdate?: () => Promise<void> };
const bridge = (): Bridge | undefined => (window as { dolphinDesktop?: Bridge }).dolphinDesktop;
const LATER_KEY = 'dolphin.desktop.update-later';

export default function UpdateNotice() {
  const [update, setUpdate] = useState<UpdateState | null>(() => bridge()?.update?.() ?? null);
  const [later, setLater] = useState<string>(() => {
    try { return localStorage.getItem(LATER_KEY) ?? ''; } catch { return ''; }
  });

  useEffect(() => { bridge()?.onUpdate?.(setUpdate); }, []);

  if (!update || !('version' in update) || later === update.version) return null;
  const hide = () => {
    try { localStorage.setItem(LATER_KEY, update.version); } catch { /* storage is optional */ }
    setLater(update.version);
  };

  return (
    <section className="signals-tray" aria-label="Update">
      <div className="agent-hooks-row">
        <ArrowDownToLine size={15} aria-hidden="true" />
        {update.state === 'downloading' ? (
          <span role="status">Downloading Dolphin {update.version}… {update.percent}%</span>
        ) : (
          <>
            <span role="status">
              {update.state === 'ready'
                ? `Dolphin ${update.version} is ready. Restart to start using it.`
                : `Dolphin ${update.version} is available.`}
            </span>
            <div className="signals-actions">
              <button type="button" className="signals-primary" onClick={() => void bridge()?.applyUpdate?.()}>
                {update.state === 'ready' ? 'Restart to Update' : 'Download'}
              </button>
              <button type="button" onClick={hide}>Later</button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
