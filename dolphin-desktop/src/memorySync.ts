/* Memory is a choice the user makes in Dolphin Desktop (settings.ts: `memory`).
 * Only this computer has a brain: its helper downloads GBrain only after it is
 * told to (app/brain.py, POST /api/brain/consent). Every machine reached over
 * SSH is told memory is off, so it never sets one up; its work reaches this
 * computer's brain through the sync (brainSync.ts). No Electron here, so
 * test/memory-sync.test.mjs can load it. */

export type MemoryEvent = 'connected' | 'changed';
type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean }>;

/** What to tell a machine, or null for nothing. This computer: connecting
 *  only ever opts it in (its memory may predate the setting), and a change in
 *  Settings goes both ways. A machine over SSH: off, once, on connect. */
export function memoryChoiceFor(event: MemoryEvent, wanted: boolean, kind: 'local' | 'ssh' = 'local'): boolean | null {
  if (kind === 'ssh') return event === 'connected' ? false : null;
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
