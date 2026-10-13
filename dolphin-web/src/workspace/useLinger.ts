import { useEffect, useState } from 'react';

/** A hidden tab or minimized window keeps its terminal this long, then lets go. */
export const HIDDEN_DETACH_MS = 60_000;

/** True while `active`, and for `ms` after it stops being. Never true before it first is. */
export function useLinger(active: boolean, ms: number): boolean {
  const [kept, setKept] = useState(active);
  useEffect(() => {
    if (active) { setKept(true); return; }
    const timer = setTimeout(() => setKept(false), ms);
    return () => clearTimeout(timer);
  }, [active, ms]);
  return active || kept;
}
