import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('dolphinAskpass', {
  answer: (id: string, answer: string | null) => ipcRenderer.send('dolphin:askpass-answer', id, answer),
});
