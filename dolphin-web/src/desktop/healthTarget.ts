import type { MachineLink } from '../machines';

/* Whose System Health to show. A machine that is not connected right now gets
   a plain "not connected", never this computer's numbers under its name. */

export type HealthTarget =
  | { kind: 'local'; label: string | undefined }
  | { kind: 'remote'; label: string; base: string; token: string }
  | { kind: 'unavailable'; label: string };

export function healthTarget(machine: string, links: MachineLink[], host: string | undefined): HealthTarget {
  if (machine === 'local') return { kind: 'local', label: host };
  const link = links.find((item) => item.id === machine);
  if (link && link.state === 'connected' && link.apiBase && link.token !== null) {
    return { kind: 'remote', label: link.label, base: link.apiBase, token: link.token };
  }
  return { kind: 'unavailable', label: link?.label ?? machine };
}
