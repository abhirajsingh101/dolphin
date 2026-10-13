import { targetKey, type Target } from './targets';

/** Two targets that show the same: one session, under one name, on one machine. */
const sameTarget = (x: Target, y: Target) => targetKey(x) === targetKey(y) && x.projectName === y.projectName && x.machine === y.machine;

/* React.memo's comparison for GlassSessionWindow. The workspace rebuilds the
   target, sessions and states objects on every render; their content is what
   matters. Every other prop, including callbacks, compares by identity, so a
   prop an earlier or later area adds is never silently ignored. */
export function sameWindowProps(previous: Record<string, unknown>, next: Record<string, unknown>): boolean {
  for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    const a = previous[key];
    const b = next[key];
    if (Object.is(a, b)) continue;
    if (key === 'target' && a && b && sameTarget(a as Target, b as Target)) continue;
    if (key === 'sessions' && Array.isArray(a) && Array.isArray(b) && a.length === b.length
      && a.every((item, index) => sameTarget(item as Target, b[index] as Target))) continue;
    if (key === 'states' && JSON.stringify(a) === JSON.stringify(b)) continue;
    return false;
  }
  return true;
}
