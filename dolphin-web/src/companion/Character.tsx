import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import { castOf } from './cast';
import { animate, Critter, stopAnimating, type Mood } from './rig';

/* A companion character on the page: the rig drawn into a box and kept moving
   by the shared clock. `critter` lets a parent carry, drop or boop it. */

// The body without the room its effects need, so the face is as large as the box allows.
const FRAME = '12 6 96 106';

export type CharacterHandle = { readonly critter: Critter | null };

export default forwardRef<CharacterHandle, { kind: string | null | undefined; mood: Mood; size: number; className?: string }>(
  function Character({ kind, mood, size, className }, ref) {
    const host = useRef<HTMLDivElement>(null);
    const critter = useRef<Critter | null>(null);
    const moodNow = useRef(mood);
    moodNow.current = mood;
    useLayoutEffect(() => {
      const element = host.current;
      if (!element) return;
      const c = new Critter(element, castOf(kind), FRAME);
      c.mood = moodNow.current; // Arrives already in its mood; only a change is acted.
      critter.current = c;
      animate(c);
      return () => { stopAnimating(c); c.destroy(); critter.current = null; };
    }, [kind]);
    useEffect(() => { critter.current?.setMood(mood); }, [mood]);
    useImperativeHandle(ref, () => ({ get critter() { return critter.current; } }), []);
    return <div ref={host} className={`dt-companion-character${className ? ` ${className}` : ''}`} style={{ width: size, height: size }} aria-hidden="true" />;
  },
);
