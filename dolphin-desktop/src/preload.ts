/* The only bridge between a window and the main process. It hands the renderer
 * its helper's address and token (read synchronously, before any app code
 * runs), and a few narrow calls. No Node APIs reach the page. */

import { contextBridge, ipcRenderer } from 'electron';

const config = ipcRenderer.sendSync('dolphin:config') as { apiBase: string; token: string; host: string } | null;
// Which Dolphin window this is: its number keeps its layout apart from the
// other windows' (the page's windowScope.ts); fresh means New Window opened it.
const windowInfo = ipcRenderer.sendSync('dolphin:window') as { slot: number; fresh: boolean } | null;

contextBridge.exposeInMainWorld('dolphinDesktop', {
  config: config ?? undefined,
  // Lets the page lay out its header around this platform's window controls.
  platform: process.platform,
  window: windowInfo ?? undefined,
  newWindow: () => ipcRenderer.send('dolphin:new-window'),
  // App updates (updates.ts): the current state, changes to it, and the button.
  update: () => ipcRenderer.sendSync('dolphin:update-state'),
  onUpdate: (listener: (state: unknown) => void) => {
    const heard = (_event: unknown, state: unknown) => listener(state);
    ipcRenderer.on('dolphin:update', heard);
    return () => { ipcRenderer.removeListener('dolphin:update', heard); };
  },
  applyUpdate: (): Promise<void> => ipcRenderer.invoke('dolphin:update-apply'),
  checkUpdates: (): Promise<unknown> => ipcRenderer.invoke('dolphin:update-check'),
  // Check for Updates… in the menu opens the window's About panel.
  onOpenUpdates: (listener: () => void) => {
    const heard = () => listener();
    ipcRenderer.on('dolphin:update-open', heard);
    return () => { ipcRenderer.removeListener('dolphin:update-open', heard); };
  },
  whatsNew: () => ipcRenderer.sendSync('dolphin:whats-new'),
  whatsNewSeen: () => ipcRenderer.send('dolphin:whats-new-seen'),
  onFullscreen: (listener: (fullscreen: boolean) => void) => {
    ipcRenderer.on('dolphin:fullscreen', (_event, fullscreen: boolean) => listener(Boolean(fullscreen)));
  },
  setBadge: (count: number) => ipcRenderer.send('dolphin:badge', count),
  // Finished turns (main.ts): the main process raises system notifications
  // itself; a click opens the session here. `notify` raises one from the page.
  notify: (payload: { title: string; body: string; machine: string; projectId: string; session: string }) => ipcRenderer.send('dolphin:notify', payload),
  onOpenSession: (listener: (target: { machine: string; projectId: string; session: string }) => void) => {
    // The target waits in the main process until the page takes it: on every
    // ping, and once now, for a click that opened this window.
    const take = () => {
      const target = ipcRenderer.sendSync('dolphin:take-open-session');
      if (target) listener(target);
    };
    ipcRenderer.on('dolphin:open-session', take);
    take();
    return () => { ipcRenderer.removeListener('dolphin:open-session', take); };
  },
  setSystemNotifications: (enabled: boolean) => ipcRenderer.send('dolphin:system-notifications', enabled),
  // The workspace's theme choice, for the windows and pages it cannot reach (theme.ts).
  setTheme: (choice: 'system' | 'light' | 'dark') => ipcRenderer.send('dolphin:theme', choice),
  // What the static pages show (static/theme.js): 'light' or 'dark', and each change.
  theme: (): 'light' | 'dark' => ipcRenderer.sendSync('dolphin:theme-get'),
  onTheme: (listener: (theme: 'light' | 'dark') => void) => { ipcRenderer.on('dolphin:theme-changed', (_event, theme) => listener(theme)); },
  // Desktop settings (settings.ts): update channel, memory, crash reports.
  settings: {
    get: () => ipcRenderer.sendSync('dolphin:settings-get'),
    set: (patch: Record<string, unknown>) => ipcRenderer.invoke('dolphin:settings-set', patch),
  },
  // Keyboard commands from the menu (keymap.ts): palette, session-1…9, and the rest.
  onCommand: (listener: (id: string) => void) => {
    const heard = (_event: unknown, id: unknown) => listener(String(id));
    ipcRenderer.on('dolphin:command', heard);
    return () => { ipcRenderer.removeListener('dolphin:command', heard); };
  },
  retry: () => ipcRenderer.send('dolphin:retry'),
  openLogs: () => ipcRenderer.send('dolphin:open-logs'),
  sshHosts: (): Promise<string[]> => ipcRenderer.invoke('dolphin:ssh-hosts'),
  // Machines (main.ts, machines.ts): what can be connected to, and the
  // machines this window works on, each with its helper's address and token.
  machines: (): Promise<unknown[]> => ipcRenderer.invoke('dolphin:machines'),
  machineList: (): unknown[] => ipcRenderer.sendSync('dolphin:machine-list'),
  onMachineList: (listener: (machines: unknown[]) => void) => {
    const heard = (_event: unknown, machines: unknown[]) => listener(machines);
    ipcRenderer.on('dolphin:machines', heard);
    return () => { ipcRenderer.removeListener('dolphin:machines', heard); };
  },
  openMachine: (target: string): Promise<{ ok?: boolean; error?: string }> => ipcRenderer.invoke('dolphin:open-machine', target),
  closeMachine: (target: string) => ipcRenderer.send('dolphin:close-machine', target),
  forgetMachine: (target: string): Promise<void> => ipcRenderer.invoke('dolphin:forget-machine', target),
  // This computer's link, for the launch page.
  connection: () => ipcRenderer.sendSync('dolphin:connection-state'),
  reconnect: (target: string) => ipcRenderer.send('dolphin:reconnect', target),
  setupKey: (target: string): Promise<{ ok?: boolean; error?: string }> => ipcRenderer.invoke('dolphin:setup-key', target),
  setAgentForwarding: (target: string, on: boolean): Promise<{ ok?: boolean; error?: string }> => ipcRenderer.invoke('dolphin:agent-forwarding', target, on),
  dismissKey: (target: string) => ipcRenderer.send('dolphin:dismiss-key', target),
  remoteLog: (target: string): Promise<{ ok?: boolean; file?: string; error?: string }> => ipcRenderer.invoke('dolphin:remote-log', target),
  // Connect to Machine… in the menu opens the window's own dialog.
  onConnectOpen: (listener: () => void) => {
    const heard = () => listener();
    ipcRenderer.on('dolphin:connect-open', heard);
    return () => { ipcRenderer.removeListener('dolphin:connect-open', heard); };
  },
  connect: (target: string): Promise<{ ok?: boolean; error?: string }> => ipcRenderer.invoke('dolphin:connect', target),
  // A port or a web link on a machine, opened in this computer's browser:
  // forwarded over SSH and rewritten when it is the machine's localhost.
  openPort: (machine: string, port: number): Promise<{ url?: string; error?: string }> => ipcRenderer.invoke('dolphin:open-port', machine, port),
  openUrl: (machine: string, url: string): Promise<{ url?: string; error?: string }> => ipcRenderer.invoke('dolphin:open-url', machine, url),
});

// The network changed (Wi-Fi back, VPN up): every machine link checks at
// once instead of waiting for its next health check.
for (const kind of ['online', 'offline'] as const) {
  window.addEventListener(kind, () => ipcRenderer.send('dolphin:network-changed', kind));
}
