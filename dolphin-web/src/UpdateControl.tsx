import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { ArrowDownToLine, CheckCircle2, LoaderCircle, RefreshCw, RotateCw, Sparkles, TriangleAlert, X } from 'lucide-react';
import DolphinIcon from './DolphinIcon';
import './updateControl.css';

/* Dolphin Desktop updates (dolphin-desktop/src/updates.ts), shown the way
   modern desktop apps do it: checks and downloads happen quietly, a pill in
   the header appears only when there is something to do, and the About panel
   (the Dolphin logo, ⌘K, or Check for Updates… in the menu) shows the version
   and checks on demand. After an update, a toast says what is new, once. */

export type UpdateState = (
  | { state: 'idle' | 'checking' | 'current' }
  | { state: 'available'; version: string; action: 'download'; url: string; notesUrl: string }
  | { state: 'downloading'; version: string; percent: number; notesUrl: string }
  | { state: 'ready'; version: string; action: 'restart'; notesUrl: string }
  | { state: 'error'; message: string }
) & { appVersion?: string; checkedAt?: number };

type WhatsNew = { version: string; notesUrl: string };
type Bridge = {
  update?: () => UpdateState;
  onUpdate?: (listener: (state: UpdateState) => void) => (() => void) | void;
  applyUpdate?: () => Promise<void>;
  checkUpdates?: () => Promise<unknown>;
  onOpenUpdates?: (listener: () => void) => (() => void) | void;
  whatsNew?: () => WhatsNew | null;
  whatsNewSeen?: () => void;
};
const bridge = (): Bridge | undefined => (window as { dolphinDesktop?: Bridge }).dolphinDesktop;

/** True in Dolphin Desktop builds that can check for updates. */
export const canUpdate = () => Boolean(bridge()?.checkUpdates);

export function checkedAgo(at: number | undefined, now = Date.now()): string {
  if (!at) return 'Not checked yet';
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return 'Checked just now';
  if (minutes < 60) return `Checked ${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Checked ${hours} hour${hours === 1 ? '' : 's'} ago`;
  return `Checked ${new Date(at).toLocaleDateString()}`;
}

/** Under the Dolphin logo, wherever the header has put it. */
const brandAnchor = (): CSSProperties | undefined => {
  const brand = document.querySelector('.glass-brand')?.getBoundingClientRect();
  return brand ? { top: brand.bottom + 10, left: Math.max(16, brand.left) } : undefined;
};

const installer = () => {
  const platform = document.documentElement.dataset.platform;
  return platform === 'darwin' ? 'the new Dolphin for your Mac' : 'the installer for this computer';
};

/** Where the About panel drops from: the Dolphin logo (also for ⌘K and the
 *  menu), or the update pill. */
export type AboutAnchor = 'brand' | 'pill';

export default function UpdateControl({ open, onOpenChange }: { open: AboutAnchor | null; onOpenChange: (open: AboutAnchor | null) => void }) {
  const [update, setUpdate] = useState<UpdateState | null>(() => bridge()?.update?.() ?? null);
  // Shown once: it counts as seen when dismissed, followed, or after it leaves by itself.
  const [whatsNew, setWhatsNew] = useState<WhatsNew | null>(() => bridge()?.whatsNew?.() ?? null);
  const [, tick] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const openRef = useRef(onOpenChange);
  openRef.current = onOpenChange;

  useEffect(() => {
    const stopUpdates = bridge()?.onUpdate?.(setUpdate);
    const stopOpen = bridge()?.onOpenUpdates?.(() => openRef.current('brand'));
    return () => { stopUpdates?.(); stopOpen?.(); };
  }, []);

  useEffect(() => {
    if (!whatsNew) return;
    const timer = window.setTimeout(() => { bridge()?.whatsNewSeen?.(); setWhatsNew(null); }, 15_000);
    return () => window.clearTimeout(timer);
  }, [whatsNew]);

  // "Checked 3 minutes ago" keeps itself true while the panel is open.
  useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(() => tick((n) => n + 1), 30_000);
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !root.current?.contains(event.target as Node)) onOpenChange(null);
    };
    document.addEventListener('keydown', close);
    document.addEventListener('pointerdown', close);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('keydown', close);
      document.removeEventListener('pointerdown', close);
    };
  }, [open, onOpenChange]);

  if (!update) return null;
  const seen = () => { bridge()?.whatsNewSeen?.(); setWhatsNew(null); };
  const check = () => void bridge()?.checkUpdates?.();
  const apply = () => void bridge()?.applyUpdate?.();
  const pending = update.state === 'available' || update.state === 'downloading' || update.state === 'ready';

  return (
    <div className="update-control" ref={root}>
      {pending && (
        <button
          type="button"
          className="update-pill"
          data-state={update.state}
          aria-haspopup="dialog"
          aria-expanded={open === 'pill'}
          onClick={() => onOpenChange(open ? null : 'pill')}
          title={update.state === 'ready' ? `Dolphin ${update.version} is ready` : `Dolphin ${update.version}`}
        >
          {update.state === 'downloading' ? (
            <span className="update-ring" style={{ ['--update-progress' as string]: `${update.percent}%` }} aria-hidden="true" />
          ) : update.state === 'ready' ? (
            <RotateCw size={14} aria-hidden="true" />
          ) : (
            <ArrowDownToLine size={14} aria-hidden="true" />
          )}
          <span>{update.state === 'ready' ? 'Restart to Update' : update.state === 'downloading' ? 'Updating' : 'Update'}</span>
        </button>
      )}

      {open && (
        <div className="update-panel" role="dialog" aria-label="About Dolphin" data-anchor={open} style={open === 'brand' ? brandAnchor() : undefined}>
          <button type="button" className="update-close" aria-label="Close" onClick={() => onOpenChange(null)}>
            <X size={14} />
          </button>
          <div className="update-identity">
            <span className="dolphin-mark"><DolphinIcon /></span>
            <span>
              <strong>Dolphin</strong>
              <small>Version {update.appVersion || '—'}</small>
            </span>
          </div>

          <div className="update-status" role="status" data-state={update.state}>
            {update.state === 'checking' && <><LoaderCircle className="update-spin" size={16} aria-hidden="true" /><span><strong>Checking for updates…</strong></span></>}
            {(update.state === 'current' || update.state === 'idle') && (
              <>
                <CheckCircle2 size={16} aria-hidden="true" />
                <span>
                  <strong>{update.state === 'current' ? 'Dolphin is up to date' : 'Updates are checked automatically'}</strong>
                  <small>{checkedAgo(update.checkedAt)}</small>
                </span>
              </>
            )}
            {update.state === 'error' && (
              <>
                <TriangleAlert size={16} aria-hidden="true" />
                <span>
                  <strong>Could not check for updates</strong>
                  <small>{update.message}. Check your connection and try again.</small>
                </span>
              </>
            )}
            {update.state === 'available' && (
              <>
                <ArrowDownToLine size={16} aria-hidden="true" />
                <span>
                  <strong>Dolphin {update.version} is available</strong>
                  <small>Download opens {installer()}.</small>
                </span>
              </>
            )}
            {update.state === 'downloading' && (
              <>
                <ArrowDownToLine size={16} aria-hidden="true" />
                <span>
                  <strong>Downloading Dolphin {update.version}</strong>
                  <small>{update.percent}% · You can keep working.</small>
                </span>
              </>
            )}
            {update.state === 'ready' && (
              <>
                <Sparkles size={16} aria-hidden="true" />
                <span>
                  <strong>Dolphin {update.version} is ready</strong>
                  <small>Restarting takes a few seconds, and your terminal sessions keep running. It also installs the next time you quit.</small>
                </span>
              </>
            )}
          </div>
          {update.state === 'downloading' && (
            <div className="update-progress" role="progressbar" aria-label="Download progress" aria-valuenow={update.percent} aria-valuemin={0} aria-valuemax={100}>
              <span style={{ transform: `scaleX(${update.percent / 100})` }} />
            </div>
          )}

          <footer className="update-actions">
            {'notesUrl' in update && <a href={update.notesUrl} target="_blank" rel="noreferrer">What’s new</a>}
            {update.state === 'ready' ? (
              <button type="button" className="update-primary" onClick={apply}>Restart to Update</button>
            ) : update.state === 'available' ? (
              <button type="button" className="update-primary" onClick={apply}>Download</button>
            ) : update.state === 'downloading' ? null : (
              <button type="button" className="update-primary" disabled={update.state === 'checking'} onClick={check}>
                <RefreshCw size={13} aria-hidden="true" /> {update.state === 'error' ? 'Try Again' : 'Check for Updates'}
              </button>
            )}
          </footer>
        </div>
      )}

      {whatsNew && !open && (
        <div className="update-toast" role="status" aria-label="Dolphin updated">
          <Sparkles size={15} aria-hidden="true" />
          <span>
            <strong>Updated to Dolphin {whatsNew.version}</strong>
            <a href={whatsNew.notesUrl} target="_blank" rel="noreferrer" onClick={seen}>See what’s new</a>
          </span>
          <button type="button" aria-label="Dismiss" onClick={seen}><X size={13} /></button>
        </div>
      )}
    </div>
  );
}
