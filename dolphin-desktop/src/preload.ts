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
    ipcRenderer.on('dolphin:update', (_event, state: unknown) => listener(state));
  },
  applyUpdate: (): Promise<void> => ipcRenderer.invoke('dolphin:update-apply'),
  onFullscreen: (listener: (fullscreen: boolean) => void) => {
    ipcRenderer.on('dolphin:fullscreen', (_event, fullscreen: boolean) => listener(Boolean(fullscreen)));
  },
  setBadge: (count: number) => ipcRenderer.send('dolphin:badge', count),
  retry: () => ipcRenderer.send('dolphin:retry'),
  openLogs: () => ipcRenderer.send('dolphin:open-logs'),
  sshHosts: (): Promise<string[]> => ipcRenderer.invoke('dolphin:ssh-hosts'),
  connect: (target: string): Promise<{ ok?: boolean; error?: string }> => ipcRenderer.invoke('dolphin:connect', target),
});
