/** The tab after (or before) `current`, across every open window in order. */
export function adjacentTab(groups: string[][], current: string | null, step: 1 | -1): string | null {
  const tabs = groups.flat();
  if (!tabs.length) return null;
  const index = current === null ? -1 : tabs.indexOf(current);
  if (index < 0) return step === 1 ? tabs[0] : tabs[tabs.length - 1];
  return tabs[(index + step + tabs.length) % tabs.length];
}
