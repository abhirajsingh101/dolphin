/* Each machine link carries an epoch the page passes to its terminals as
 * `reconnectKey` (GlassSessionWindow): when it moves, every terminal on that
 * machine drops its socket and attaches again. It moves when the link comes
 * back to connected from any other state, or its token or address changes
 * while connected. No Electron here (test/link-epoch.test.mjs). */

export type LinkSnapshot = { state: string; token: string | null; apiBase: string | null };

export function nextEpoch(epoch: number, before: LinkSnapshot | undefined, after: LinkSnapshot): number {
  if (!before || after.state !== 'connected') return epoch;
  if (before.state !== 'connected') return epoch + 1;
  return before.token !== after.token || before.apiBase !== after.apiBase ? epoch + 1 : epoch;
}
