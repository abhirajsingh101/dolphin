/* Sidebar project identity: what a project row actually shows.
   Every project lives under DOLPHIN_WORKSPACE_ROOTS (default
   /home/me/projects), so rendering absolute paths repeats the same
   20-odd characters on every row and pushes the part that distinguishes
   projects off the right edge. The frontend is not told the roots, so we
   recover the shared prefix from the paths themselves. */

/** Longest shared leading directory across every linked path.
    Returns '' when fewer than two paths share a real parent. */
export function commonPathPrefix(paths: readonly (string | null)[]): string {
  const usable = paths.filter(
    (path): path is string => typeof path === 'string' && path.startsWith('/'),
  );
  if (usable.length < 2) return '';

  const segmentLists = usable.map((path) =>
    path.split('/').filter((segment) => segment.length > 0),
  );
  // A project directory must remain, so never consume a path entirely.
  const limit = Math.min(...segmentLists.map((list) => list.length)) - 1;

  const shared: string[] = [];
  for (let index = 0; index < limit; index += 1) {
    const segment = segmentLists[0][index];
    if (!segmentLists.every((list) => list[index] === segment)) break;
    shared.push(segment);
  }
  return shared.length === 0 ? '' : `/${shared.join('/')}`;
}

/** The path with the shared prefix removed: '/home/me/projects/brain' -> 'brain'. */
export function relativeProjectPath(
  path: string | null,
  prefix: string,
): string | null {
  if (!path) return null;
  if (!prefix || !path.startsWith(`${prefix}/`)) return path;
  const remainder = path.slice(prefix.length + 1);
  return remainder.length > 0 ? remainder : path;
}

function normalizeForComparison(value: string): string {
  return value.toLowerCase().replace(/[\s_-]+/g, '');
}

/** The secondary line for a project row, or null when it would only repeat
    the name. "Dolphin Tasks" at "dolphin-tasks" says nothing twice; "Robot
    Console" at "robot-control" is worth showing. */
export function projectPathLabel(
  name: string,
  path: string | null,
  prefix: string,
): string | null {
  const relative = relativeProjectPath(path, prefix);
  if (!relative) return null;
  if (normalizeForComparison(relative) === normalizeForComparison(name)) {
    return null;
  }
  return relative;
}

/* Project accent slots. Stored colours are Todoist-era hexes (#3B82F6,
   #D1453B, ...) that clash with the teal-locked palette, but the per-project
   dot is still a useful identity cue. Map each project onto a harmonised
   slot so identity survives and the palette stays locked. Slot values live
   in tokens.css as --proj-1 ... --proj-6.

   Seed on the project id, not the stored colour: nearly every project keeps
   the backend default (#246FE0), so hashing the colour collapses the whole
   rail onto a single slot and destroys the identity cue it exists to
   provide. The id is unique and stable, so dots stay put across reloads. */
export const PROJECT_ACCENT_SLOTS = 6;

/* FNV-1a plus a final avalanche mix. Project ids are 32-char lowercase hex,
   so they draw on only 16 distinct characters; a plain `hash * 31 + c` over
   that alphabet left two of the six slots permanently unused and piled a
   third of the rail onto one colour. The avalanche step spreads high-order
   entropy down into the low bits that `% SLOTS` actually reads. */
export function projectAccentVar(seed: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15;
  return `var(--proj-${((hash >>> 0) % PROJECT_ACCENT_SLOTS) + 1})`;
}
