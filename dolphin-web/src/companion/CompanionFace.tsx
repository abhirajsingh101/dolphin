import { useEffect, useRef, type CSSProperties } from 'react';
import { projectAccentVar } from '../projectIdentity';
import { faceOf, type Mood } from './companionModel';

/* The character itself: a body in the project's identity colour, a face
   plate, and eyes that carry the mood. Drawn from the project id, so every
   project has one the moment it exists. The eyes follow the pointer while it
   is near; nothing else moves unless the mood is a status (working, alert). */

const BODIES = {
  pebble: <path d="M24 7c10.5 0 17 7.4 17 18.2C41 35.4 34.2 42 24 42S7 35.4 7 25.2C7 14.4 13.5 7 24 7z" />,
  drop: <path d="M24 5c6.6 7.4 17 13.3 17 23.2C41 36.3 33.6 42 24 42S7 36.3 7 28.2C7 18.3 17.4 12.4 24 5z" />,
  bean: <path d="M9 24.5C9 14.6 15.5 8 24.5 8S40 14.6 40 24.5v3C40 36.2 33.4 42 24.5 42S9 36.2 9 27.5z" />,
  cube: <rect x="7" y="9" width="34" height="33" rx="12" />,
} as const;

const ACCESSORIES = {
  none: null,
  sprout: <path d="M24 9c0-3 .4-5 2.6-6.6C28.8 4 28.4 6.6 24 9zm0 0c-.3-2-1.6-3.3-3.6-3.6.2 2 1.5 3.3 3.6 3.6z" />,
  antenna: <><path d="M24 9V4" strokeWidth="1.6" strokeLinecap="round" className="dt-companion-line" /><circle cx="24" cy="3.4" r="2" /></>,
  ears: <><path d="M12.5 15.5 11 7.5l7.4 3.6z" /><path d="M35.5 15.5 37 7.5l-7.4 3.6z" /></>,
} as const;

function Eyes({ mood, held }: { mood: Mood; held: boolean }) {
  if (held) return <g className="dt-companion-eyes"><path d="M18 26.5l3.5 1.5-3.5 1.5M30 26.5l-3.5 1.5 3.5 1.5" /></g>;
  if (mood === 'done') return <g className="dt-companion-eyes"><path d="M17.8 29q2.2-3.4 4.4 0M25.8 29q2.2-3.4 4.4 0" /></g>;
  if (mood === 'sleep') return <g className="dt-companion-eyes"><path d="M18 28.5h4M26 28.5h4" /></g>;
  const r = mood === 'alert' ? 2.5 : 2;
  return <g className="dt-companion-eyes" data-look><ellipse cx="20" cy="28" rx={r} ry={r + 0.6} /><ellipse cx="28" cy="28" rx={r} ry={r + 0.6} /></g>;
}

export default function CompanionFace({ seed, mood, size = 44, held = false, follow = true }: {
  seed: string;
  mood: Mood;
  size?: number;
  held?: boolean;
  /** Eyes follow the pointer when it is within a few hundred pixels. */
  follow?: boolean;
}) {
  const { shape, accessory } = faceOf(seed);
  const svg = useRef<SVGSVGElement>(null);
  useEffect(() => {
    const element = svg.current;
    if (!follow || !element || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let frame = 0;
    const move = (event: PointerEvent) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const eyes = element.querySelector<SVGGElement>('[data-look]');
        if (!eyes) return;
        const box = element.getBoundingClientRect();
        const dx = event.clientX - (box.left + box.width / 2);
        const dy = event.clientY - (box.top + box.height * 0.58);
        const far = Math.hypot(dx, dy) > 420;
        const scale = far ? 0 : 1.6 / Math.max(1, Math.hypot(dx, dy) / 40);
        eyes.style.transform = `translate(${Math.max(-1.6, Math.min(1.6, dx * scale / 40))}px, ${Math.max(-1.2, Math.min(1.2, dy * scale / 40))}px)`;
      });
    };
    window.addEventListener('pointermove', move, { passive: true });
    return () => { cancelAnimationFrame(frame); window.removeEventListener('pointermove', move); };
  }, [follow, mood, held]);
  return <svg ref={svg} className="dt-companion-face" data-mood={mood} data-held={held || undefined} width={size} height={size} viewBox="0 0 48 48" aria-hidden="true" style={{ '--companion-body': projectAccentVar(seed) } as CSSProperties}>
    <ellipse className="dt-companion-shadow" cx="24" cy="45" rx="12" ry="2" />
    <g className="dt-companion-body">
      <g className="dt-companion-fill">{BODIES[shape]}{ACCESSORIES[accessory]}</g>
      <ellipse className="dt-companion-plate" cx="24" cy="28" rx="11.5" ry="8" />
      <Eyes mood={mood} held={held} />
      {mood === 'alert' && <circle className="dt-companion-alert" cx="38" cy="11" r="3.4" />}
    </g>
  </svg>;
}
