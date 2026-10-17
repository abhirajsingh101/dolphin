/* Every machine's work comes home to this computer's brain (the helper's
 * app/brain_sync.py). Each machine Dolphin is connected to exports what is new
 * since its cursor: its projects, and what was asked and answered in its
 * Claude Code and Codex sessions (every minute). Only this computer has a
 * brain. This computer's helper takes each export into
 * its brain, labelled with the machine it came from. The traffic runs over the
 * SSH link each machine already has. This computer exports its own projects
 * and turns too, and keeps its own brain where it is.
 *
 * A cursor moves on only once this computer has taken the export, so nothing is
 * skipped across a dropped link or a restart. No Electron here, so
 * test/brain-sync.test.mjs can load it. */

export type Endpoint = { apiBase: string; token: string };
export type SyncMachine = { id: string; kind: 'local' | 'ssh'; endpoint: Endpoint };
export type SyncResult = { cursor: unknown; rounds: number; stopped?: 'memory-off' | 'failed'; busy?: boolean; error?: string };
type Response = { ok: boolean; status: number; json: () => Promise<unknown> };
export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<Response>;

/** How often every connected machine's sessions are brought up to date, besides on connect. */
export const SYNC_INTERVAL_MS = 60 * 1000;
/** Exports per machine per sync; a long backlog finishes on the next one. */
const MAX_ROUNDS = 25;

type Export = { hostname?: string; cursor?: unknown; has_more?: boolean };

/** Bring one machine's export into this computer's brain, from `cursor` on. */
export async function syncMachine(machine: SyncMachine, local: Endpoint, cursor: unknown, fetcher: Fetch): Promise<SyncResult> {
  let rounds = 0;
  let busy = false;
  while (rounds < MAX_ROUNDS) {
    const query = new URLSearchParams({ cursor: JSON.stringify(cursor ?? {}) });
    let body: Export;
    try {
      const response = await fetcher(`${machine.endpoint.apiBase}/api/brain/export?${query}`, {
        method: 'GET', headers: { 'X-Dolphin-Token': machine.endpoint.token },
      });
      // A helper older than this sync has no export (404): nothing to bring yet.
      if (!response.ok) return { cursor, rounds, stopped: 'failed', error: `export answered ${response.status}` };
      body = (await response.json()) as Export;
    } catch (error) {
      return { cursor, rounds, stopped: 'failed', error: String(error) };
    }
    const label = machine.kind === 'local' ? body.hostname || 'This Computer' : machine.id;
    const id = machine.kind === 'local' ? body.hostname || 'this-computer' : machine.id;
    try {
      const response = await fetcher(`${local.apiBase}/api/brain/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Dolphin-Token': local.token },
        body: JSON.stringify({ machine: { id, label, kind: machine.kind }, export: body }),
      });
      if (response.status === 409) return { cursor, rounds, stopped: 'memory-off' };
      if (!response.ok) return { cursor, rounds, stopped: 'failed', error: `import answered ${response.status}` };
      busy = Boolean(((await response.json()) as { busy?: boolean }).busy);
    } catch (error) {
      return { cursor, rounds, stopped: 'failed', error: String(error) };
    }
    cursor = body.cursor ?? cursor;
    rounds += 1;
    if (!body.has_more) break;
  }
  return { cursor, rounds, busy };
}

/** Bring every machine in turn, keeping each cursor as soon as it moves. */
export async function syncAll(
  targets: SyncMachine[], local: Endpoint, cursors: Record<string, unknown>,
  save: (cursors: Record<string, unknown>) => void, fetcher: Fetch,
): Promise<Record<string, SyncResult>> {
  const results: Record<string, SyncResult> = {};
  for (const machine of targets) {
    const result = await syncMachine(machine, local, cursors[machine.id], fetcher);
    results[machine.id] = result;
    if (result.rounds > 0) {
      cursors[machine.id] = result.cursor;
      save(cursors);
    }
    if (result.stopped === 'memory-off') break;
  }
  return results;
}
