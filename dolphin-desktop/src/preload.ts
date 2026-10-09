/* The only bridge between a window and the main process. It hands the renderer
 * its helper's address and token (read synchronously, before any app code
 * runs), and a few narrow calls. No Node APIs reach the page. */

import { contextBridge, ipcRenderer } from 'electron';

const config = ipcRenderer.sendSync('dolphin:config') as { apiBase: string; token: string; host: string } | null;

contextBridge.exposeInMainWorld('dolphinDesktop', {
  config: config ?? undefined,
  setBadge: (count: number) => ipcRenderer.send('dolphin:badge', count),
  sshHosts: (): Promise<string[]> => ipcRenderer.invoke('dolphin:ssh-hosts'),
  connect: (target: string): Promise<{ ok?: boolean; error?: string }> => ipcRenderer.invoke('dolphin:connect', target),
});
