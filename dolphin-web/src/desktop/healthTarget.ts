import { machineStatus, type MachineLink } from '../machines';

/* Whose System Health to show. A machine that is not connected right now gets
   a plain "not connected", never this computer's numbers under its name. */

/** A machine's link state, or `unknown` for an id this window has no machine for. */
export type HealthMachineState = MachineLink['state'] | 'unknown';

export type HealthTarget =
  | { kind: 'local'; label: string | undefined }
  | { kind: 'remote'; label: string; base: string; token: string }
  | {
      kind: 'unavailable';
      label: string;
      state: HealthMachineState;
      /** Why, in the link's own words (a failure, or why it dropped). */
      detail: string | null;
      /** What to hand the bridge's reconnect, when reconnecting can help. */
      reconnect: string | null;
    };

export function healthTarget(machine: string, links: MachineLink[], host: string | undefined): HealthTarget {
  if (machine === 'local') return { kind: 'local', label: host };
  const link = links.find((item) => item.id === machine);
  if (link && link.state === 'connected' && link.apiBase && link.token !== null) {
    return { kind: 'remote', label: link.label, base: link.apiBase, token: link.token };
  }
  if (!link) return { kind: 'unavailable', label: machine, state: 'unknown', detail: null, reconnect: null };
  // Connected but without an address yet reads as still connecting.
  const state = link.state === 'connected' ? 'connecting' : link.state;
  const detail = link.state === 'failed' ? link.error : link.state === 'offline' ? link.reason : link.status;
  const reconnect = state === 'offline' || state === 'failed' ? link.target ?? link.id : null;
  return { kind: 'unavailable', label: link.label, state, detail: detail || null, reconnect };
}

/** Where System Health for a machine lives: `#/health` is this computer. */
export function healthHash(machine: string): string {
  return machine === 'local' ? '#/health' : `#/health/${encodeURIComponent(machine)}`;
}

/** One entry in System Health's machine menu. */
export type HealthMachine = {
  id: string;
  kind: 'local' | 'ssh';
  label: string;
  state: HealthMachineState;
  status: string;
  current: boolean;
  href: string;
};

/** Every machine System Health can show, in the projects list's order (this
    computer first), with the one on screen marked. A machine the window no
    longer has stays listed while it is the one on screen, so the menu never
    loses track of what is showing. */
export function healthMachines(current: string, links: MachineLink[], host: string | undefined): HealthMachine[] {
  const list: HealthMachine[] = links.map((link) => ({
    id: link.id,
    kind: link.kind,
    label: link.kind === 'local' ? 'This computer' : link.label,
    state: link.kind === 'local' ? 'connected' : link.state,
    status: link.kind === 'local' ? link.hostname ?? host ?? 'This computer' : machineStatus(link),
    current: link.id === current,
    href: healthHash(link.id),
  }));
  if (!list.some((item) => item.id === 'local')) {
    list.unshift({ id: 'local', kind: 'local', label: 'This computer', state: 'connected', status: host ?? 'This computer', current: current === 'local', href: healthHash('local') });
  }
  if (!list.some((item) => item.current)) {
    list.push({ id: current, kind: 'ssh', label: current, state: 'unknown', status: 'Not in this window', current: true, href: healthHash(current) });
  }
  return list;
}
