import type { ControlCenterProject } from '../types';

/** True when a fresh snapshot says exactly what the last one did (compared by content, not length). */
export function sameProjects(previous: ControlCenterProject[] | undefined, next: ControlCenterProject[]): boolean {
  return previous !== undefined && JSON.stringify(previous) === JSON.stringify(next);
}
