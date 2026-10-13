/** `record` with only the `keep` keys; the same object when nothing is dropped. */
export function pickKeys<T>(record: Record<string, T>, keep: readonly string[]): Record<string, T> {
  const wanted = new Set(keep);
  const entries = Object.entries(record).filter(([key]) => wanted.has(key));
  return entries.length === Object.keys(record).length ? record : Object.fromEntries(entries);
}

/** Add `value` to `seen` as its newest entry, forgetting the oldest past `max`. */
export function rememberBounded(seen: Set<string>, value: string, max = 1000): void {
  seen.delete(value);
  seen.add(value);
  while (seen.size > max) {
    const oldest = seen.values().next().value;
    if (oldest === undefined) break;
    seen.delete(oldest);
  }
}
