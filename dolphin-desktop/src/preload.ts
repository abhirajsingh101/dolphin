/* The only bridge between a window and the main process. It hands the renderer
 * its helper's address and token (read synchronously, before any app code
 * runs), and a few narrow calls. No Node APIs reach the page. */

import { contextBridge, ipcRenderer } from 'electron';

const config = ipcRenderer.sendSync('dolphin:config') as { apiBase: string; token: string; host: string } | null;

contextBridge.exposeInMainWorld('dolphinDesktop', {
  config: config ?? undefined,
  // Lets the page lay out its header around this platform's window controls.
  platform: process.platform,
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
  retry: () => ipcRenderer.send('dolphin:retry'),
  openLogs: () => ipcRenderer.send('dolphin:open-logs'),
  sshHosts: (): Promise<string[]> => ipcRenderer.invoke('dolphin:ssh-hosts'),
  // Machines (main.ts, machines.ts): what can be connected to, and this window's link.
  machines: (): Promise<unknown[]> => ipcRenderer.invoke('dolphin:machines'),
  openMachine: (target: string): Promise<{ ok?: boolean; error?: string }> => ipcRenderer.invoke('dolphin:open-machine', target),
  forgetMachine: (target: string): Promise<void> => ipcRenderer.invoke('dolphin:forget-machine', target),
  connection: () => ipcRenderer.sendSync('dolphin:connection-state'),
  onConnection: (listener: (state: unknown) => void) => {
    const heard = (_event: unknown, state: unknown) => listener(state);
    ipcRenderer.on('dolphin:connection', heard);
    return () => { ipcRenderer.removeListener('dolphin:connection', heard); };
  },
  reconnect: () => ipcRenderer.send('dolphin:reconnect'),
  setupKey: (): Promise<{ ok?: boolean; error?: string }> => ipcRenderer.invoke('dolphin:setup-key'),
  dismissKey: () => ipcRenderer.send('dolphin:dismiss-key'),
  // Connect to Machine… in the menu opens the window's own dialog.
  onConnectOpen: (listener: () => void) => {
    const heard = () => listener();
    ipcRenderer.on('dolphin:connect-open', heard);
    return () => { ipcRenderer.removeListener('dolphin:connect-open', heard); };
  },
  connect: (target: string): Promise<{ ok?: boolean; error?: string }> => ipcRenderer.invoke('dolphin:connect', target),
});
