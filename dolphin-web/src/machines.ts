/* Dolphin Desktop's machines, as the page sees them through the preload
   bridge (dolphin-desktop/src/main.ts and machines.ts). */

export type MachineSource = 'recent' | 'config' | 'history' | 'tailscale' | 'known';
export type Machine = { target: string; label: string; detail?: string; source: MachineSource; online?: boolean; lastUsed?: number; open?: boolean };
export type Link = { kind: 'local' | 'ssh'; target: string | null; label: string; state: 'connecting' | 'connected' | 'reconnecting' | 'offline'; reason: string | null; offerKey: boolean };

type Bridge = {
  machines?: () => Promise<Machine[]>;
  openMachine?: (target: string) => Promise<{ ok?: boolean; error?: string }>;
  forgetMachine?: (target: string) => Promise<void>;
  connection?: () => Link | null;
  onConnection?: (listener: (link: Link) => void) => (() => void) | void;
  reconnect?: () => void;
  setupKey?: () => Promise<{ ok?: boolean; error?: string }>;
  dismissKey?: () => void;
  onConnectOpen?: (listener: () => void) => (() => void) | void;
};

export const machineBridge = (): Bridge | undefined => (window as { dolphinDesktop?: Bridge }).dolphinDesktop;

/** True in Dolphin Desktop builds that can connect to other machines. */
export const canConnect = () => Boolean(machineBridge()?.machines);

/** What ssh will accept from Dolphin: a name, user@host, or ssh://user@host:port. */
export function validTarget(target: string): boolean {
  return /^(ssh:\/\/)?[A-Za-z0-9._@:-]{1,253}$/.test(target) && !/^-/.test(target.replace(/^ssh:\/\//, ''));
}

export const SOURCE_LABEL: Record<MachineSource, string> = {
  recent: 'Recent',
  config: 'From your SSH config',
  history: 'From your shell history',
  tailscale: 'On your tailnet',
  known: 'Known hosts',
};

/** Machines matching what the user typed, best first: name starts, then contains, then detail. */
export function filterMachines(machines: Machine[], query: string): Machine[] {
  const q = query.trim().toLowerCase();
  if (!q) return machines;
  const score = (machine: Machine) => {
    const label = machine.label.toLowerCase();
    const target = machine.target.toLowerCase();
    if (label.startsWith(q) || target.startsWith(q)) return 3;
    if (label.includes(q) || target.includes(q)) return 2;
    return (machine.detail ?? '').toLowerCase().includes(q) ? 1 : 0;
  };
  return machines.map((machine) => ({ machine, score: score(machine) })).filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score).map((item) => item.machine);
}
