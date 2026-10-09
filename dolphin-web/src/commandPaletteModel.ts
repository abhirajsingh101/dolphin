export type PaletteItemKind = 'action' | 'task' | 'project' | 'session';

export interface PaletteItem {
  id: string;
  kind: PaletteItemKind;
  label: string;
  hint?: string;
}

export interface PaletteGroup {
  kind: PaletteItemKind;
  heading: string;
  items: PaletteItem[];
}

const ORDER: PaletteItemKind[] = ['action', 'task', 'project', 'session'];
const HEADINGS: Record<PaletteItemKind, string> = {
  action: 'Actions',
  task: 'Tasks',
  project: 'Projects',
  session: 'Sessions',
};

export function scoreItem(item: PaletteItem, query: string): number {
  const needle = query.trim().toLowerCase();
  if (!needle) return 1;

  const label = item.label.toLowerCase();
  if (label.startsWith(needle)) return 100 - label.length / 1000;
  if (label.includes(needle)) return 50 - label.length / 1000;

  const hint = item.hint?.toLowerCase() ?? '';
  if (hint.includes(needle)) return 25 - hint.length / 1000;
  return 0;
}

export function searchPalette(
  items: PaletteItem[],
  query: string,
  limit = 20,
): PaletteGroup[] {
  const scored = items
    .map((item) => ({ item, score: scoreItem(item, query) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.item);

  return ORDER.map((kind) => ({
    kind,
    heading: HEADINGS[kind],
    items: scored.filter((item) => item.kind === kind),
  })).filter((group) => group.items.length > 0);
}

export function moveSelection(
  count: number,
  current: number,
  delta: number,
): number {
  if (count <= 0) return 0;
  return (((current + delta) % count) + count) % count;
}
