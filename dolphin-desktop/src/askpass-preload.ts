import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('dolphinAskpass', {
  answer: (id: string, answer: string | null) => ipcRenderer.send('dolphin:askpass-answer', id, answer),
  // The theme Dolphin shows (static/theme.js; main.ts, theme.ts).
  theme: (): 'light' | 'dark' => ipcRenderer.sendSync('dolphin:theme-get'),
  onTheme: (listener: (theme: 'light' | 'dark') => void) => { ipcRenderer.on('dolphin:theme-changed', (_event, theme) => listener(theme)); },
});
