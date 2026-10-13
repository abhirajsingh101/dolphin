import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FocusEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';

import type { Api } from '../api';
import { GLANCE_DELAY_MS, GLANCE_LINES, GLANCE_REFRESH_MS, lastLines } from './glance';

export type GlanceTarget = { key: string; label: string; projectId: string; sessionName: string; api: Api };
export type Shown = { target: GlanceTarget; rect: DOMRect };
export const GLANCE_ID = 'glass-glance';

/** Which row the glance is on. It shows after a short rest of the pointer or on keyboard focus, and never takes focus. */
export function useGlance() {
  const [shown, setShown] = useState<Shown | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hide = useCallback(() => { clearTimeout(timer.current); setShown(null); }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  const bind = (target: GlanceTarget | null): Record<string, unknown> => target ? {
    onPointerEnter: (event: ReactPointerEvent<HTMLElement>) => {
      if (event.pointerType === 'touch') return;
      const element = event.currentTarget;
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setShown({ target, rect: element.getBoundingClientRect() }), GLANCE_DELAY_MS);
    },
    onPointerLeave: hide,
    onPointerDown: hide,
    onFocus: (event: FocusEvent<HTMLElement>) => {
      if (!event.currentTarget.matches(':focus-visible')) return;
      clearTimeout(timer.current);
      setShown({ target, rect: event.currentTarget.getBoundingClientRect() });
    },
    onBlur: hide,
    'aria-describedby': shown?.target.key === target.key ? GLANCE_ID : undefined,
  } : {};
  return { shown, bind, hide };
}

const same = (a: string[] | null, b: string[]) => a !== null && a.length === b.length && a.every((line, index) => line === b[index]);

export function GlancePopover({ shown, onClose }: { shown: Shown; onClose: () => void }) {
  const [lines, setLines] = useState<string[] | null>(null);
  const [failed, setFailed] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ top: number; left: number }>({ top: shown.rect.top, left: shown.rect.right + 8 });
  const { api, projectId, sessionName, key, label } = shown.target;
  // Polls only while this popover is mounted: unmounting on hide stops the timer and ignores a reply in flight.
  useEffect(() => {
    setLines(null);
    setFailed(false);
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const snapshot = await api.fetchTmuxSnapshot(projectId, sessionName, 40);
        if (!alive) return;
        const next = lastLines(snapshot.content, GLANCE_LINES);
        setLines((old) => (same(old, next) ? old : next));
        timer = setTimeout(load, GLANCE_REFRESH_MS);
      } catch {
        if (alive) setFailed(true);
      }
    };
    void load();
    return () => { alive = false; clearTimeout(timer); };
  }, [key, api, projectId, sessionName]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [onClose]);
  // Keep the measured box inside the viewport, whatever its height turned out to be.
  useLayoutEffect(() => {
    const height = box.current?.offsetHeight ?? 0;
    const width = box.current?.offsetWidth ?? 0;
    const top = Math.max(8, Math.min(shown.rect.top, window.innerHeight - height - 8));
    let left = shown.rect.right + 8;
    if (left + width > window.innerWidth - 8) left = Math.max(8, shown.rect.left - width - 8);
    if (left + width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - width - 8);
    setPlace((old) => (old.top === top && old.left === left ? old : { top, left }));
  }, [shown.rect, lines, failed]);
  return createPortal(
    <div ref={box} id={GLANCE_ID} role="tooltip" className="glass-glance" style={place}>
      <strong>{label}</strong>
      {failed ? <p>Preview unavailable. Open the session to see it.</p>
        : lines === null ? <p>Loading preview…</p>
          : lines.length ? <pre>{lines.join('\n')}</pre> : <p>No output yet.</p>}
    </div>,
    document.querySelector('.glass-workspace') ?? document.body,
  );
}
