import { useEffect, useRef, useState } from 'react';
import { AnimatePresence } from 'motion/react';
import { ArrowDownToLine, CircleAlert, CircleCheck, CircleX, FileDown, FolderOpen, X } from 'lucide-react';
import { MotionPopover } from './motion/MotionDialog';
import { machineBridge } from './machines';
import { fileManagerName } from './openFile';
import { downloadDetail, downloadsLabel, fractionOf, overallProgress, type Download } from './downloads';

/** How long the list stays after its last download finishes, when it opened by itself. */
export const AUTO_CLOSE_MS = 4000;
const RING = 2 * Math.PI * 12;

/* Dolphin Desktop's downloads, beside the bell: the button appears with the
   first download of this run and rings with progress; the list opens by
   itself when a download starts (without taking focus, so the terminal keeps
   the keyboard) and closes again once they are done. */
export default function DownloadsControl() {
  const bridge = machineBridge();
  const [downloads, setDownloads] = useState<Download[]>(() => (bridge?.downloads?.() as Download[] | undefined) ?? []);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [announce, setAnnounce] = useState('');
  const [holding, setHolding] = useState(false);
  const [focused, setFocused] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const openedByItself = useRef(false);
  const seen = useRef(new Set(downloads.map((download) => download.id)));
  const states = useRef(new Map(downloads.map((download) => [download.id, download.state])));
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const stop = bridge?.onDownloads?.((list) => setDownloads(list as Download[]));
    // A change sent between the first render and this subscription.
    if (bridge?.downloads) setDownloads(bridge.downloads() as Download[]);
    return stop ?? undefined;
  }, [bridge]);

  useEffect(() => {
    let started = false;
    const said: string[] = [];
    for (const download of downloads) {
      if (!seen.current.has(download.id)) {
        seen.current.add(download.id);
        if (download.state === 'progressing') started = true;
      }
      const before = states.current.get(download.id);
      if (before !== download.state && download.state === 'completed') said.push(`Saved ${download.name} to Downloads.`);
      else if (before !== download.state && download.state === 'failed') said.push(`${download.name} did not download.`);
      states.current.set(download.id, download.state);
    }
    // A new string each time, so the same file saved twice is said twice.
    if (said.length) setAnnounce((current) => `${said.join(' ')}${current.endsWith('\u200b') ? '' : '\u200b'}`);
    if (downloads.length === 0) setOpen(false);
    if (started) {
      setOpen((current) => {
        if (!current) openedByItself.current = true;
        return true;
      });
    }
  }, [downloads]);

  const { active, fraction } = overallProgress(downloads);
  useEffect(() => {
    if (!open || !openedByItself.current || active > 0 || holding || focused) return;
    const timer = window.setTimeout(() => setOpen(false), AUTO_CLOSE_MS);
    return () => window.clearTimeout(timer);
  }, [open, active, holding, focused]);

  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent) {
        if (event.key !== 'Escape') return;
        // Focus inside the list goes back to its button, not to the page.
        if (root.current?.contains(document.activeElement)) trigger.current?.focus();
        setOpen(false);
      } else if (!root.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('keydown', close);
    document.addEventListener('pointerdown', close);
    return () => {
      document.removeEventListener('keydown', close);
      document.removeEventListener('pointerdown', close);
    };
  }, [open]);
  useEffect(() => { if (!open) { setNote(''); setHolding(false); setFocused(false); } }, [open]);

  if (!bridge?.downloads || downloads.length === 0) return null;
  const finder = fileManagerName();
  const show = (download: Download) => {
    void bridge.showDownload?.(download.id).then((result) => setNote(result?.error ?? ''), (reason) => setNote(String(reason)));
  };

  return (
    <div className="glass-downloads" ref={root} onPointerEnter={() => setHolding(true)} onPointerLeave={() => setHolding(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => { if (!root.current?.contains(event.relatedTarget as Node | null)) setFocused(false); }}>
      <button
        ref={trigger}
        className="glass-downloads-button"
        aria-label={downloadsLabel(downloads)}
        title={downloadsLabel(downloads)}
        aria-expanded={open}
        aria-haspopup="dialog"
        data-active={active > 0}
        onClick={() => { openedByItself.current = false; setOpen((value) => !value); }}
      >
        <ArrowDownToLine size={16} aria-hidden="true" />
        {active > 0 && (
          <svg className="glass-downloads-ring" viewBox="0 0 28 28" aria-hidden="true" data-indeterminate={fraction === null}>
            <circle className="glass-downloads-track" cx="14" cy="14" r="12" />
            <circle className="glass-downloads-arc" cx="14" cy="14" r="12" strokeDasharray={RING}
              strokeDashoffset={fraction === null ? RING * 0.72 : RING * (1 - fraction)} />
          </svg>
        )}
      </button>
      <span className="dt-sr-only" role="status" aria-live="polite">{announce}</span>
      <AnimatePresence>
        {open && (
          <MotionPopover key="panel" align="right" className="glass-downloads-panel" role="dialog" aria-label="Downloads">
            <header>
              <strong>Downloads</strong>
              <button disabled={downloads.every((download) => download.state === 'progressing')} onClick={() => { trigger.current?.focus(); bridge.clearDownloads?.(); }}>Clear</button>
            </header>
            <ul>
              {downloads.map((download) => {
                const share = fractionOf(download);
                const Icon = download.state === 'completed' ? CircleCheck : download.state === 'failed' ? CircleAlert : download.state === 'cancelled' ? CircleX : FileDown;
                return (
                  <li key={download.id} data-state={download.state}>
                    <Icon size={16} aria-hidden="true" />
                    <span className="glass-download-text">
                      <strong title={download.state === 'completed' ? download.file : download.name}>{download.name}</strong>
                      <small>{downloadDetail(download)}</small>
                      {download.state === 'progressing' && (
                        <span className="glass-download-bar" role="progressbar" aria-label={`${download.name} progress`}
                          aria-valuemin={0} aria-valuemax={100} aria-valuenow={share === null ? undefined : Math.round(share * 100)}
                          data-indeterminate={share === null}>
                          <i style={share === null ? undefined : { transform: `scaleX(${share})` }} />
                        </span>
                      )}
                    </span>
                    {download.state === 'progressing' && (
                      <button className="glass-download-action" aria-label={`Cancel ${download.name}`} title="Cancel" onClick={() => { trigger.current?.focus(); bridge.cancelDownload?.(download.id); }}>
                        <X size={14} aria-hidden="true" />
                      </button>
                    )}
                    {download.state === 'completed' && (
                      <button className="glass-download-action" aria-label={`Show ${download.name} in ${finder}`} title={`Show in ${finder}`} onClick={() => show(download)}>
                        <FolderOpen size={14} aria-hidden="true" />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
            {note && <footer role="alert">{note}</footer>}
          </MotionPopover>
        )}
      </AnimatePresence>
    </div>
  );
}
