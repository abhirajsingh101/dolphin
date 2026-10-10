/* Dolphin Desktop's main process.
 *
 * Opens the machines that were open when Dolphin last quit (this computer the
 * first time). Connect to a Machine (the machine chip in the header, ⌘K, the
 * menu, ⌘/Ctrl+Shift+O) opens a window per SSH host, which stays connected:
 * a dropped link comes back by itself (hosts.ts). Each window
 * gets the address and token of its own helper through the preload; the
 * renderer is served from the app:// origin, which the helper's CORS allows. */

import { app, BrowserWindow, BrowserWindowConstructorOptions, ipcMain, Menu, nativeTheme, net, powerMonitor, protocol, shell } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { startAskpass } from './askpass';
import { checkFromMenu, startUpdateChecks } from './updates';
import { connectLocal, connectSsh, Connection, helperDir, HostSpec, installKey, LinkState, setSshEnv, sshConfigHosts } from './hosts';
import { detectMachines, forgetMachine, rememberMachine, validTarget } from './machines';

const APP_ORIGIN = 'app://dolphin';
const rendererRoot = app.isPackaged
  ? path.join(process.resourcesPath, 'renderer')
  : path.resolve(__dirname, '..', '..', 'dolphin-web', 'dist-desktop');
const staticRoot = path.resolve(__dirname, '..', 'static');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

type WindowState = { connection?: Connection; host: HostSpec; title: string; link: LinkState | 'connecting'; reason?: string; offerKey?: boolean };
const windows = new Map<number, WindowState>();

function serveApp(): void {
  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    const root = url.hostname === 'connect' ? staticRoot : rendererRoot;
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'desktop.html';
    const file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
}

function hardenWindow(window: BrowserWindow): void {
  // Links to the web open in the user's browser, never inside the app.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url) && !url.startsWith('http://127.0.0.1')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('app://')) event.preventDefault();
  });
}

/** The header row every Dolphin page draws at its top (glass.css, style.css). */
export const HEADER_HEIGHT = 44;

/** No separate title bar: the window controls sit inside the page's own header,
 *  as in other modern desktop apps. macOS keeps its traffic lights, placed in
 *  the header's left end; Linux and Windows draw their controls over its right
 *  end, and the page leaves that space free (env(titlebar-area-*)). The header
 *  is the drag area (app-region: drag). */
function windowChrome(): BrowserWindowConstructorOptions {
  const background = nativeTheme.shouldUseDarkColors ? '#0f1722' : '#eef3f9';
  if (process.platform === 'darwin') {
    return { titleBarStyle: 'hidden', trafficLightPosition: { x: 18, y: (HEADER_HEIGHT - 14) / 2 }, backgroundColor: background };
  }
  return { titleBarStyle: 'hidden', titleBarOverlay: { color: '#00000000', height: HEADER_HEIGHT }, backgroundColor: background };
}

async function openHost(host: HostSpec, from?: BrowserWindow, bounds?: Electron.Rectangle): Promise<void> {
  const title = host.kind === 'local' ? 'This Computer' : host.target;
  const window = from ?? new BrowserWindow({
    width: 1440, height: 900, ...bounds, minWidth: 720, minHeight: 480, show: false, title: `Dolphin — ${title}`,
    ...windowChrome(),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  hardenWindow(window);
  // The title names the machine this window works on; pages don't override it.
  window.on('page-title-updated', (event) => event.preventDefault());
  // macOS hides the traffic lights in full screen; the page then reclaims their space.
  window.on('enter-full-screen', () => window.webContents.send('dolphin:fullscreen', true));
  window.on('leave-full-screen', () => window.webContents.send('dolphin:fullscreen', false));
  const state: WindowState = { host, title, link: 'connecting' };
  // Read the id now: by 'closed', webContents is destroyed and touching it throws,
  // which stalled the app's quit.
  const id = window.webContents.id;
  windows.set(id, state);
  window.on('closed', () => {
    state.connection?.close();
    windows.delete(id);
    saveSession();
  });
  saveSession();
  if (!from) {
    await window.loadURL(`app://connect/status.html#${encodeURIComponent(`Opening ${title}…`)}`);
    window.show();
  }
  const status = (text: string) => void window.webContents.executeJavaScript(`window.setStatus && window.setStatus(${JSON.stringify(text)})`).catch(() => undefined);
  try {
    state.connection = host.kind === 'local'
      ? await connectLocal(app.isPackaged ? process.resourcesPath : undefined, path.resolve(__dirname, '..'))
      : await connectSsh(host.target, helperDir(app.isPackaged ? process.resourcesPath : undefined, path.resolve(__dirname, '..')), status);
    window.setTitle(`Dolphin — ${state.connection.label}`);
    state.link = 'connected';
    if (host.kind === 'ssh') {
      rememberMachine(app.getPath('userData'), host.target);
      state.offerKey = state.connection.usedPassword;
      state.connection.watch?.((link, info) => {
        state.link = link;
        state.reason = info.reason;
        if (window.isDestroyed()) return;
        // The helper restarted with a new token: the page reads it at load.
        if (link === 'connected' && info.tokenChanged) window.reload();
        else window.webContents.send('dolphin:connection', linkOf(state));
      });
    }
    await window.loadURL(`${APP_ORIGIN}/desktop.html#/workspace`);
  } catch (error) {
    const detail = host.kind === 'ssh' ? explainSsh(host.target, error) : error instanceof Error ? error.message : String(error);
    void window.webContents.executeJavaScript(
      `window.setError ? window.setError(${JSON.stringify(`Could not open ${title}`)}, ${JSON.stringify(detail)}) : window.setStatus(${JSON.stringify(detail)})`,
    ).catch(() => undefined);
  }
}

/** What went wrong reaching a machine, said plainly, with ssh's own words after it. */
function explainSsh(target: string, error: unknown): string {
  const raw = (error instanceof Error ? error.message : String(error)).trim();
  const plain = /could not resolve hostname|name or service not known|nodename nor servname/i.test(raw)
    ? `No machine named ${target} was found. Check the name, or use its IP address.`
    : /connection refused/i.test(raw)
      ? `${target} is reachable, but SSH isn't running there. On a Mac, turn on Remote Login in System Settings › General › Sharing.`
      : /timed out|no route to host|network is unreachable/i.test(raw)
        ? `${target} didn't answer. Check that it is on and reachable from here (same network, VPN or tailnet).`
        : /permission denied/i.test(raw)
          ? `${target} didn't accept your SSH key or password.`
          : '';
  return plain ? `${plain}\n\n${raw}` : raw;
}

// The launch page's buttons after a failure: start this window's host again,
// or show the helper's logs.
ipcMain.on('dolphin:retry', (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  const state = windows.get(event.sender.id);
  if (!window || !state) return;
  // A fresh window for the same machine, in the same place; the failed one goes.
  void openHost(state.host, undefined, window.getBounds());
  window.close();
});
ipcMain.on('dolphin:open-logs', () => void shell.openPath(path.join(app.getPath('home'), '.dolphin-server', 'logs')));

/* --- machines ------------------------------------------------------------- */

const linkOf = (state: WindowState) => ({
  kind: state.host.kind, target: state.host.kind === 'ssh' ? state.host.target : null, label: state.connection?.label ?? state.title,
  state: state.link, reason: state.reason ?? null, offerKey: Boolean(state.offerKey),
});
const targetOf = (host: HostSpec) => (host.kind === 'local' ? 'local' : host.target);

/** Bring the window for a machine forward, or open one. */
function openMachine(target: string): void {
  for (const [id, state] of windows) {
    if (targetOf(state.host) === target) {
      const window = BrowserWindow.getAllWindows().find((item) => !item.isDestroyed() && item.webContents.id === id);
      if (window) {
        if (window.isMinimized()) window.restore();
        window.focus();
        return;
      }
    }
  }
  void openHost(target === 'local' ? { kind: 'local' } : { kind: 'ssh', target });
}

/* The machines open when Dolphin quits come back at the next launch, each in
   its own window where it was. Saved on every open and close, but not while
   quitting closes them all. */
let quitting = false;
const sessionFile = () => path.join(app.getPath('userData'), 'session.json');
type Saved = { target: string; bounds?: Electron.Rectangle };
function saveSession(): void {
  if (quitting) return;
  const open: Saved[] = [];
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    const state = windows.get(window.webContents.id);
    if (state) open.push({ target: targetOf(state.host), bounds: window.getNormalBounds() });
  }
  try { writeFileSync(sessionFile(), JSON.stringify({ open }, null, 2)); } catch { /* restoring is a convenience */ }
}
function restoreSession(): void {
  let saved: Saved[] = [];
  try { saved = (JSON.parse(readFileSync(sessionFile(), 'utf8')) as { open?: Saved[] }).open ?? []; } catch { /* first launch */ }
  saved = saved.filter((item) => item.target === 'local' || validTarget(item.target));
  if (saved.length === 0) saved = [{ target: 'local' }];
  for (const item of saved) void openHost(item.target === 'local' ? { kind: 'local' } : { kind: 'ssh', target: item.target }, undefined, item.bounds);
}

ipcMain.on('dolphin:connection-state', (event) => {
  const state = windows.get(event.sender.id);
  event.returnValue = state ? linkOf(state) : null;
});
ipcMain.handle('dolphin:machines', async () => {
  const open = new Set([...windows.values()].map((state) => targetOf(state.host)));
  return (await detectMachines(app.getPath('userData'))).map((machine) => ({ ...machine, open: open.has(machine.target) }));
});
ipcMain.handle('dolphin:open-machine', (_event, target: unknown) => {
  if (typeof target !== 'string' || (target !== 'local' && !validTarget(target))) return { error: 'Enter a machine like gpu-box, user@10.0.0.5 or ssh://user@host:2222.' };
  openMachine(target);
  return { ok: true };
});
ipcMain.handle('dolphin:forget-machine', (_event, target: unknown) => {
  if (typeof target === 'string') forgetMachine(app.getPath('userData'), target);
});
ipcMain.on('dolphin:reconnect', (event) => windows.get(event.sender.id)?.connection?.reconnectNow?.(true));
ipcMain.handle('dolphin:setup-key', async (event) => {
  const state = windows.get(event.sender.id);
  if (!state || state.host.kind !== 'ssh') return { error: 'Only machines reached over SSH sign in.' };
  try {
    await installKey(state.host.target);
    state.offerKey = false;
    return { ok: true };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
});
ipcMain.on('dolphin:dismiss-key', (event) => {
  const state = windows.get(event.sender.id);
  if (state) state.offerKey = false;
});

/** Connect to a Machine… : the focused window's own dialog, or a small window when none is open. */
function connectFromMenu(): void {
  const focused = BrowserWindow.getFocusedWindow();
  const state = focused ? windows.get(focused.webContents.id) : undefined;
  if (focused && state?.connection) focused.webContents.send('dolphin:connect-open');
  else openConnectWindow();
}

function openConnectWindow(): void {
  const window = new BrowserWindow({
    width: 520, height: 560, resizable: false, title: 'Connect to Machine',
    ...windowChrome(),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  hardenWindow(window);
  void window.loadURL('app://connect/connect.html');
}

ipcMain.on('dolphin:config', (event) => {
  const state = windows.get(event.sender.id);
  event.returnValue = state?.connection
    ? { apiBase: state.connection.apiBase, token: state.connection.token, host: state.connection.label }
    : null;
});
ipcMain.handle('dolphin:ssh-hosts', () => sshConfigHosts());
ipcMain.handle('dolphin:connect', async (event, target: unknown) => {
  if (typeof target !== 'string' || !validTarget(target.trim())) return { error: 'Enter a machine like gpu-box, user@10.0.0.5 or ssh://user@host:2222.' };
  BrowserWindow.fromWebContents(event.sender)?.close();
  openMachine(target.trim());
  return { ok: true };
});
ipcMain.on('dolphin:badge', (_event, count: unknown) => {
  if (typeof count === 'number' && Number.isFinite(count)) app.setBadgeCount(Math.max(0, Math.floor(count)));
});

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{
      label: app.name,
      submenu: [
        { role: 'about' as const },
        { label: 'Check for Updates…', click: () => void checkFromMenu(BrowserWindow.getFocusedWindow() ?? undefined) },
        { type: 'separator' as const },
        { role: 'services' as const },
        { type: 'separator' as const },
        { role: 'hide' as const }, { role: 'hideOthers' as const }, { role: 'unhide' as const },
        { type: 'separator' as const },
        { role: 'quit' as const },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Window for This Computer', accelerator: 'CmdOrCtrl+Shift+N', click: () => void openHost({ kind: 'local' }) },
        { label: 'Connect to Machine…', accelerator: 'CmdOrCtrl+Shift+O', click: connectFromMenu },
        { type: 'separator' },
        process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    { role: 'help', submenu: [
      ...(process.platform === 'darwin' ? [] : [{ label: 'Check for Updates…', click: () => void checkFromMenu(BrowserWindow.getFocusedWindow() ?? undefined) }]),
      { label: 'Dolphin Logs', click: () => void shell.openPath(path.join(app.getPath('home'), '.dolphin-server', 'logs')) },
    ] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [first] = BrowserWindow.getAllWindows();
    if (first) {
      if (first.isMinimized()) first.restore();
      first.focus();
    }
  });
  app.whenReady().then(() => {
    serveApp();
    setSshEnv(startAskpass());
    startUpdateChecks();
    buildMenu();
    restoreSession();
    // Back from sleep: every machine link tries again at once.
    powerMonitor.on('resume', () => { for (const state of windows.values()) state.connection?.reconnectNow?.(false); });
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) void openHost({ kind: 'local' });
    });
  });
  // Drop every relay and SSH forward on quit; open connections must not hold the app open.
  app.on('before-quit', () => { saveSession(); quitting = true; });
  app.on('will-quit', () => {
    for (const state of windows.values()) state.connection?.close();
    // Nothing in this process needs flushing: helpers and tmux are detached and
    // keep running. Exit now; a live notification stream in the network
    // service otherwise held the quit open indefinitely.
    app.exit(0);
  });
  // Closing windows never stops agents: the helper and tmux keep running.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

