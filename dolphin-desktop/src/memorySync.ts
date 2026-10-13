/* Memory is a choice the user makes in Dolphin Desktop (settings.ts: `memory`),
 * and every machine follows it: a helper downloads GBrain only after it is
 * told to (app/brain.py, POST /api/brain/consent). No Electron here, so
 * test/memory-sync.test.mjs can load it. */

export type MemoryEvent = 'connected' | 'changed';
type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean }>;

/** What to tell a machine, or null for nothing. Connecting only ever opts a
 *  machine in: one is never switched off for having been connected while the
 *  setting was off (its memory may predate the setting). */
export function memoryChoiceFor(event: MemoryEvent, wanted: boolean): boolean | null {
  if (event === 'connected') return wanted ? true : null;
  return wanted;
}

/** Tell one helper. A helper older than 0.2.0 has no consent endpoint and
 *  answers 404; that only means it keeps its old behaviour, so nothing throws. */
export async function sendMemoryChoice(apiBase: string, token: string, enabled: boolean, fetcher: Fetch): Promise<boolean> {
  try {
    const response = await fetcher(`${apiBase}/api/brain/consent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Dolphin-Token': token },
      body: JSON.stringify({ enabled }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** 0.1.x set memory up unasked. When this computer already has a ready brain
 *  and no choice was ever recorded, the setting starts on, so Settings tells
 *  the truth. Returns the value to store, or null to leave the file alone. */
export function seededMemory(raw: Record<string, unknown>, brainState: string | null): boolean | null {
  if ('memory' in raw) return null;
  try {
    return (JSON.parse(brainState ?? '') as { state?: string }).state === 'ready' ? true : null;
  } catch {
    return null;
  }
}
