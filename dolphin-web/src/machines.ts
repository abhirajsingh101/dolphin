import { useEffect, useState } from 'react';

/* Dolphin Desktop's machines, as the page sees them through the preload
   bridge (dolphin-desktop/src/main.ts and machines.ts). */

export type MachineSource = 'recent' | 'config' | 'history' | 'tailscale' | 'known';
export type Machine = { target: string; label: string; detail?: string; source: MachineSource; online?: boolean; lastUsed?: number; open?: boolean };
/** A machine this window works on, with its state and, once connected, its
    helper's address and token. `local` is this computer and always first. */
export type MachineLink = {
  id: string;
  kind: 'local' | 'ssh';
  target: string | null;
  label: string;
  hostname: string | null;
  state: 'connecting' | 'connected' | 'reconnecting' | 'offline' | 'failed';
  status: string | null;
  error: string | null;
  reason: string | null;
  offerKey: boolean;
  apiBase: string | null;
  token: string | null;
  /** Moves each time this machine's link comes back or gets a new token or
      address (dolphin-desktop/src/link-epoch.ts). Always 0 in the web app. */
  epoch: number;
  /** SSH only: this computer's SSH agent is forwarded to new sessions there (off unless turned on). */
  agentForwarding?: boolean;
  agentError?: string | null;
};

type Bridge = {
  machines?: () => Promise<Machine[]>;
  machineList?: () => MachineLink[];
  onMachineList?: (listener: (machines: MachineLink[]) => void) => (() => void) | void;
  openMachine?: (target: string) => Promise<{ ok?: boolean; error?: string }>;
  closeMachine?: (target: string) => void;
  forgetMachine?: (target: string) => Promise<void>;
  reconnect?: (target: string) => void;
  setupKey?: (target: string) => Promise<{ ok?: boolean; error?: string }>;
  setAgentForwarding?: (target: string, on: boolean) => Promise<{ ok?: boolean; error?: string }>;
  dismissKey?: (target: string) => void;
  openPort?: (machine: string, port: number) => Promise<{ url?: string; error?: string }>;
  openUrl?: (machine: string, url: string) => Promise<{ url?: string; error?: string }>;
  remoteLog?: (target: string) => Promise<{ ok?: boolean; file?: string; error?: string }>;
  onConnectOpen?: (listener: () => void) => (() => void) | void;
  /** A click on a system notification (main.ts): open this session. */
  onOpenSession?: (listener: (target: { machine: string; projectId: string; session: string }) => void) => (() => void) | void;
  notify?: (payload: { title: string; body: string; machine: string; projectId: string; session: string }) => void;
  setSystemNotifications?: (enabled: boolean) => void;
  /** File → New Window: another window over the same machines. */
  newWindow?: () => void;
};

export const machineBridge = (): Bridge | undefined => (window as { dolphinDesktop?: Bridge }).dolphinDesktop;

/** The machines in this window, kept current. Empty outside Dolphin Desktop. */
export function useMachineLinks(enabled: boolean): MachineLink[] {
  const [links, setLinks] = useState<MachineLink[]>(() => (enabled ? machineBridge()?.machineList?.() ?? [] : []));
  useEffect(() => {
    if (!enabled) return;
    setLinks(machineBridge()?.machineList?.() ?? []);
    return machineBridge()?.onMachineList?.(setLinks) ?? undefined;
  }, [enabled]);
  return links;
}

/** True in Dolphin Desktop builds that can open another window. */
export const canOpenWindow = () => Boolean(machineBridge()?.newWindow);

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

/** `machine:epoch`, the key that makes an open terminal attach again (spec: "Machine link epoch").
 *  The machine comes from the target itself, then the project list; while it is still unknown
 *  in desktop mode there is no key, so it cannot flip from a guess to the real value. */
export function terminalReconnectKey(
  target: { projectId: string; machine?: string },
  projects: { id: string; machine: string }[],
  links: { id: string; epoch: number }[],
  desktop = false,
): string | undefined {
  const machine = target.machine ?? projects.find((project) => project.id === target.projectId)?.machine ?? (desktop ? undefined : 'local');
  if (!machine) return undefined;
  return `${machine}:${links.find((link) => link.id === machine)?.epoch ?? 0}`;
}
