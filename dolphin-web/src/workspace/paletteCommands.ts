import type { PaletteItem } from '../commandPaletteModel';

export type PaletteContext = {
  desktop: boolean; mac: boolean; canConnect: boolean; canUpdate: boolean; canOpenWindow: boolean;
  theme: 'system' | 'light' | 'dark';
  machines: { id: string; label: string; kind: 'local' | 'ssh'; state: string; target: string | null }[];
  projects: { id: string; name: string; machine: string; machineLabel: string; isInbox: boolean; sessionCount: number }[];
  sessions: { id: string; label: string; pinned: boolean }[];
  active: { id: string; label: string; pinned: boolean } | null;
};
export type PaletteCommand =
  | { kind: 'chat' } | { kind: 'settings' } | { kind: 'connect' } | { kind: 'updates' } | { kind: 'new-window' }
  | { kind: 'theme'; theme: 'system' | 'light' | 'dark' }
  | { kind: 'add-project'; machine: string } | { kind: 'project'; machine: string; projectId: string }
  | { kind: 'health'; machine: string } | { kind: 'disconnect'; target: string }
  | { kind: 'pin'; sessionId: string } | { kind: 'session'; sessionId: string };

const THEMES = [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']] as const;

/* What the command palette offers: actions, projects, sessions. A pure model, so
   what appears for which machines is tested without a page. */
export function paletteCommands(context: PaletteContext): { items: PaletteItem[]; commands: Map<string, PaletteCommand> } {
  const items: PaletteItem[] = [];
  const commands = new Map<string, PaletteCommand>();
  const add = (item: PaletteItem, command: PaletteCommand) => { items.push(item); commands.set(item.id, command); };
  const connected = context.machines.filter((machine) => machine.state === 'connected');
  const several = context.desktop && context.machines.length > 1;

  add({ id: 'dolphin', kind: 'action', label: 'Open Dolphin chat', hint: 'Your assistant' }, { kind: 'chat' });
  add({ id: 'settings', kind: 'action', label: 'Settings…', hint: context.desktop ? (context.mac ? '⌘,' : 'Ctrl+,') : 'Theme, terminal, new sessions' }, { kind: 'settings' });
  if (context.desktop && context.canOpenWindow) add({ id: 'new-window', kind: 'action', label: 'New Window', hint: context.mac ? '⌘N' : 'Ctrl+Shift+N' }, { kind: 'new-window' });
  if (context.desktop && context.canConnect) add({ id: 'connect-machine', kind: 'action', label: 'Connect to a Machine…', hint: 'Work on another computer over SSH' }, { kind: 'connect' });
  if (context.desktop && context.canUpdate) add({ id: 'check-updates', kind: 'action', label: 'Check for Updates', hint: 'About Dolphin' }, { kind: 'updates' });
  for (const [theme, name] of THEMES) add({ id: `theme:${theme}`, kind: 'action', label: `Theme: ${name}`, hint: context.theme === theme ? 'Current' : undefined }, { kind: 'theme', theme });
  if (several) {
    for (const machine of connected) add({ id: `add-project:${machine.id}`, kind: 'action', label: `Add Project on ${machine.kind === 'local' ? 'This Computer' : machine.label}…`, hint: 'Open a folder as a project' }, { kind: 'add-project', machine: machine.id });
  } else {
    add({ id: 'add-project:local', kind: 'action', label: 'Add Project…', hint: 'Open a folder as a project' }, { kind: 'add-project', machine: 'local' });
  }
  if (context.desktop) {
    for (const machine of connected) add({ id: `health:${machine.id}`, kind: 'action', label: machine.kind === 'local' ? 'System Health' : `System Health: ${machine.label}`, hint: 'CPU, memory, disks, GPUs' }, { kind: 'health', machine: machine.id });
    for (const machine of context.machines) {
      if (machine.kind === 'ssh' && machine.target) add({ id: `disconnect:${machine.id}`, kind: 'action', label: `Disconnect ${machine.label}`, hint: 'Sessions there keep running' }, { kind: 'disconnect', target: machine.target });
    }
  }
  if (context.active) add({ id: 'pin', kind: 'action', label: context.active.pinned ? 'Unpin Current Session' : 'Pin Current Session', hint: context.active.label }, { kind: 'pin', sessionId: context.active.id });
  for (const project of context.projects) {
    if (project.isInbox) continue;
    const prefix = several && project.machine !== 'local' ? `${project.machineLabel} · ` : '';
    add({ id: `project:${project.machine}:${project.id}`, kind: 'project', label: `${prefix}${project.name}`, hint: `${project.sessionCount} ${project.sessionCount === 1 ? 'session' : 'sessions'}` }, { kind: 'project', machine: project.machine, projectId: project.id });
  }
  for (const session of context.sessions) add({ id: session.id, kind: 'session', label: session.label, hint: session.pinned ? 'Pinned' : 'Open' }, { kind: 'session', sessionId: session.id });
  return { items, commands };
}
