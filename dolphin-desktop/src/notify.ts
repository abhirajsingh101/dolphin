/* What Dolphin Desktop's main process says when an agent finishes a turn, and
   when it says it. No Electron here, so node:test checks it directly. */

export type TurnNotification = {
  id: string; provider: 'claude' | 'codex'; project_id: string | null; project_name: string | null;
  session_name: string; summary: string; read: boolean;
};
export type OpenTarget = { machine: string; projectId: string; session: string };

const AGENT: Record<TurnNotification['provider'], string> = { claude: 'Claude Code', codex: 'Codex' };

export function isTurnNotification(value: unknown): value is TurnNotification {
  const item = value as Partial<TurnNotification> | null;
  return Boolean(item) && typeof item!.id === 'string' && (item!.provider === 'claude' || item!.provider === 'codex')
    && typeof item!.session_name === 'string' && typeof item!.summary === 'string' && typeof item!.read === 'boolean'
    && (item!.project_id === null || typeof item!.project_id === 'string')
    && (item!.project_name === null || typeof item!.project_name === 'string');
}

export function isOpenTarget(value: unknown): value is OpenTarget {
  const target = value as Partial<OpenTarget> | null;
  return Boolean(target) && typeof target!.machine === 'string' && typeof target!.projectId === 'string' && typeof target!.session === 'string';
}

/** Titled "session · project". Another machine's name goes in the subtitle on
    macOS, which shows one, and after the title elsewhere. */
export function notificationContent(item: TurnNotification, machineLabel: string | null, platform: string): { title: string; body: string; subtitle?: string } {
  const title = `${item.session_name} · ${item.project_name ?? 'No project'}`;
  const body = item.summary.trim() || `${AGENT[item.provider]} finished its turn.`;
  if (!machineLabel) return { title, body };
  return platform === 'darwin' ? { title, body, subtitle: machineLabel } : { title: `${title} · ${machineLabel}`, body };
}

/** The page's own pop-ups cover a focused window; the system covers the rest. */
export function wantsSystemNotification({ enabled, windowFocused }: { enabled: boolean; windowFocused: boolean }): boolean {
  return enabled && !windowFocused;
}

/** Which machines' streams to stop and (re)start: `key` is "apiBase token". */
export function feedChanges(current: ReadonlyMap<string, string>, wanted: ReadonlyMap<string, string>): { stop: string[]; start: string[] } {
  return {
    stop: [...current].filter(([id, key]) => wanted.get(id) !== key).map(([id]) => id),
    start: [...wanted].filter(([id, key]) => current.get(id) !== key).map(([id]) => id),
  };
}

/** The last `limit` announced ids, so a reconnect never repeats one. */
export class SeenIds {
  private readonly limit: number;
  private readonly order: string[] = [];
  private readonly ids = new Set<string>();

  constructor(limit = 500) {
    this.limit = limit;
  }

  add(id: string): boolean {
    if (this.ids.has(id)) return false;
    this.ids.add(id);
    this.order.push(id);
    if (this.order.length > this.limit) this.ids.delete(this.order.shift()!);
    return true;
  }
}

/** System notifications held by the main process so their click handlers are
 *  not collected. Each is released on click, on close, after `ttlMs` (Linux and
 *  Windows may never send `close` for one that timed out), and the oldest goes
 *  once more than `limit` are held. */
export class HeldPopups<T> {
  constructor(
    private readonly limit = 50,
    private readonly ttlMs = 10 * 60_000,
    private readonly timers: { set: (run: () => void, ms: number) => unknown; clear: (timer: unknown) => void } = {
      set: (run, ms) => setTimeout(run, ms), clear: (timer) => clearTimeout(timer as NodeJS.Timeout),
    },
  ) {}

  private readonly held = new Map<T, unknown>();

  get size(): number { return this.held.size; }

  hold(item: T): void {
    this.release(item);
    const timer = this.timers.set(() => this.release(item), this.ttlMs);
    (timer as { unref?: () => void } | null)?.unref?.();
    this.held.set(item, timer);
    while (this.held.size > this.limit) this.release(this.held.keys().next().value as T);
  }

  release(item: T): void {
    if (!this.held.has(item)) return;
    this.timers.clear(this.held.get(item));
    this.held.delete(item);
  }
}
