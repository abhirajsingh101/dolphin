import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import CompanionFace from './CompanionFace';
import { clampPoint, fromFraction, moodOf, nudgeFor, savePlace, savedPlace, snapPoint, toFraction, type Box, type Mood, type Point, type SessionMood } from './companionModel';

/* The project's character, standing in its window. One click opens the
   project's Tasks tab, where its conversation is; that is its only action.
   Drag it anywhere inside the window. It never covers the header, never
   takes keystrokes, and fades back while you type in the terminal. */

const SIZE = 44;
const HEADER = 30;
const NUDGE_MS = 6000;
const NUDGES_PER_HOUR = 4;

export default function WindowCompanion({ projectId, projectName, sessions, onOpen }: {
  projectId: string;
  projectName: string;
  sessions: readonly SessionMood[];
  onOpen: () => void;
}) {
  const self = useRef<HTMLButtonElement>(null);
  const [place, setPlace] = useState<Point | null>(null);
  const [held, setHeld] = useState(false);
  const drag = useRef<{ id: number; start: Point; from: Point; moved: boolean } | null>(null);
  // A drag ends in a click too; only a press that stayed put opens.
  const dragged = useRef(false);
  const box = (): Box | null => {
    const window = self.current?.parentElement;
    if (!window) return null;
    return { width: window.clientWidth, height: window.clientHeight, top: HEADER };
  };
  // Its remembered place, or the lower right corner; kept inside on resize.
  useLayoutEffect(() => {
    const window = self.current?.parentElement;
    if (!window) return;
    const settle = () => {
      const b = box();
      if (!b) return;
      const saved = savedPlace(projectId);
      setPlace((current) => drag.current && current ? current : saved ? fromFraction(saved, b, SIZE) : clampPoint({ x: b.width - SIZE - 16, y: b.height - SIZE - 16 }, b, SIZE));
    };
    settle();
    const observer = new ResizeObserver(settle);
    observer.observe(window);
    return () => observer.disconnect();
  }, [projectId]);

  const now = Date.now();
  const { mood, label } = moodOf(sessions, now);
  const [nudge, setNudge] = useState<string | null>(null);
  const previous = useRef<Mood | undefined>(undefined);
  const recent = useRef<number[]>([]);
  useEffect(() => {
    const text = nudgeFor(previous.current, { mood, label });
    previous.current = mood;
    if (!text) return;
    const at = Date.now();
    recent.current = recent.current.filter((t) => at - t < 3_600_000);
    if (recent.current.length >= NUDGES_PER_HOUR) return;
    recent.current.push(at);
    setNudge(text);
  }, [mood, label]);
  useEffect(() => {
    if (!nudge) return;
    const timer = window.setTimeout(() => setNudge(null), NUDGE_MS);
    return () => window.clearTimeout(timer);
  }, [nudge]);

  function down(event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.button !== 0 || !place) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { id: event.pointerId, start: { x: event.clientX, y: event.clientY }, from: place, moved: false };
  }
  function move(event: ReactPointerEvent<HTMLButtonElement>) {
    const d = drag.current, b = box();
    if (!d || d.id !== event.pointerId || !b) return;
    const dx = event.clientX - d.start.x, dy = event.clientY - d.start.y;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    if (!d.moved) { d.moved = true; setHeld(true); setNudge(null); }
    setPlace(clampPoint({ x: d.from.x + dx, y: d.from.y + dy }, b, SIZE));
  }
  function up(event: ReactPointerEvent<HTMLButtonElement>) {
    const d = drag.current, b = box();
    if (!d || d.id !== event.pointerId) return;
    drag.current = null;
    if (!d.moved || !b || !place) return;
    dragged.current = true;
    setHeld(false);
    const settled = snapPoint(place, b, SIZE);
    setPlace(settled);
    savePlace(projectId, toFraction(settled, b, SIZE));
  }

  const b = box();
  const bubbleLeft = place && b ? place.x > b.width / 2 : false;
  return <>
    <button
      ref={self}
      type="button"
      className="dt-companion"
      data-mood={mood}
      data-held={held || undefined}
      hidden={!place}
      style={place ? { transform: `translate(${place.x}px, ${place.y}px)` } : undefined}
      aria-label={`${projectName}: ${label}. Open its tasks and chat`}
      title={label}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={() => { drag.current = null; setHeld(false); }}
      onKeyDown={(event) => {
        // The arrow keys move it, for anyone not using a pointer.
        const step = { ArrowLeft: [-16, 0], ArrowRight: [16, 0], ArrowUp: [0, -16], ArrowDown: [0, 16] }[event.key];
        const b = box();
        if (!step || !place || !b) return;
        event.preventDefault();
        const next = clampPoint({ x: place.x + step[0], y: place.y + step[1] }, b, SIZE);
        setPlace(next);
        savePlace(projectId, toFraction(next, b, SIZE));
      }}
      onClick={(event) => {
        if (dragged.current) { dragged.current = false; event.preventDefault(); return; }
        setNudge(null);
        onOpen();
      }}
    >
      <CompanionFace seed={projectId} mood={mood} size={SIZE} held={held} />
    </button>
    {nudge && place && <button
      type="button"
      className="dt-companion-nudge"
      data-side={bubbleLeft ? 'left' : 'right'}
      style={{ transform: `translate(${bubbleLeft ? place.x - 8 : place.x + SIZE + 8}px, ${place.y + 6}px)${bubbleLeft ? ' translateX(-100%)' : ''}` }}
      onClick={() => { setNudge(null); onOpen(); }}
    >{nudge}</button>}
    <span role="status" className="dt-sr-only">{nudge ?? ''}</span>
  </>;
}
