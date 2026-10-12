/* Dolphin Desktop's main process.
 *
 * One window holds every machine Dolphin works on: this computer, and any
 * machine added from Connect to a Machine (the projects list, ⌘K, the menu,
 * ⌘/Ctrl+Shift+O), which stays connected: a dropped link comes back by itself
 * (hosts.ts). The machines open when Dolphin last quit come back at launch.
 * The page gets this computer's helper through the preload, and every
 * machine's address and token in the machine list; it is served from the
 * app:// origin, which the helpers' CORS allows. */

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

/* --- machines ------------------------------------------------------------- */

/* Every machine Dolphin works on lives in one window. This computer always
   comes first; machines reached over SSH are added from Connect to a Machine,
   stay connected (hosts.ts brings a dropped link back), and each shows as its
   own section of the window's projects list. The page gets the list, with each
   machine's address and token, through the preload. */
type MachineState = {
  host: HostSpec; id: string; title: string; connection?: Connection;
  link: LinkState | 'connecting' | 'failed'; status?: string; error?: string; reason?: string; offerKey?: boolean;
  attempt: number;
};
const machines = new Map<string, MachineState>();
let mainWindow: BrowserWindow | null = null;
let workspaceShown = false;

const idOf = (host: HostSpec) => (host.kind === 'local' ? 'local' : host.target);
const infoOf = (machine: MachineState) => ({
  id: machine.id, kind: machine.host.kind, target: machine.host.kind === 'ssh' ? machine.host.target : null,
  label: machine.host.kind === 'local' ? 'This Computer' : machine.title,
  hostname: machine.connection?.label ?? null,
  state: machine.link, status: machine.status ?? null, error: machine.error ?? null,
  reason: machine.reason ?? null, offerKey: Boolean(machine.offerKey),
  apiBase: machine.link === 'failed' ? null : machine.connection?.apiBase ?? null,
  token: machine.link === 'failed' ? null : machine.connection?.token ?? null,
});
const machineList = () => [...machines.values()].map(infoOf);

function broadcast(): void {
  const window = mainWindow;
  if (!window || window.isDestroyed()) return;
  if (workspaceShown) window.webContents.send('dolphin:machines', machineList());
  else {
    // Still on the launch page: it shows this computer's progress.
    const local = machines.get('local');
    if (local?.status) void window.webContents.executeJavaScript(`window.setStatus && window.setStatus(${JSON.stringify(local.status)})`).catch(() => undefined);
  }
}

function machineFor(host: HostSpec): MachineState {
  const id = idOf(host);
  let machine = machines.get(id);
  if (!machine) {
    machine = { host, id, title: host.kind === 'local' ? 'This Computer' : host.target, link: 'connecting', attempt: 0 };
    machines.set(id, machine);
  }
  return machine;
}

/** Connect (or connect again) to one machine, telling the page each step. */
async function connect(machine: MachineState): Promise<void> {
  const attempt = ++machine.attempt;
  machine.connection?.close();
  machine.connection = undefined;
  machine.link = 'connecting';
  machine.error = undefined;
  machine.reason = undefined;
  machine.status = `Connecting to ${machine.title}…`;
  broadcast();
  const current = () => attempt === machine.attempt && machines.get(machine.id) === machine;
  try {
    const connection = machine.host.kind === 'local'
      ? await connectLocal(app.isPackaged ? process.resourcesPath : undefined, path.resolve(__dirname, '..'))
      : await connectSsh(machine.host.target, helperDir(app.isPackaged ? process.resourcesPath : undefined, path.resolve(__dirname, '..')), (text) => {
        if (!current()) return;
        machine.status = text;
        broadcast();
      });
    if (!current()) { connection.close(); return; }
    machine.connection = connection;
    machine.link = 'connected';
    machine.status = undefined;
    if (machine.host.kind === 'ssh') {
      rememberMachine(app.getPath('userData'), machine.host.target);
      machine.offerKey = connection.usedPassword;
      // A helper that restarted with a new token reaches the page as a new
      // token in the list; the page makes a new client for it.
      connection.watch?.((link, info) => {
        if (!current()) return;
        machine.link = link;
        machine.reason = info.reason;
        broadcast();
      });
    }
  } catch (error) {
    if (!current()) return;
    machine.link = 'failed';
    machine.status = undefined;
    machine.error = machine.host.kind === 'ssh' ? explainSsh(machine.host.target, error) : error instanceof Error ? error.message : String(error);
  }
  broadcast();
}

/** Add a machine to the window, or bring back one that failed. */
function openMachine(target: string): void {
  showWindow();
  if (target === 'local') return;
  const known = machines.has(target);
  const machine = machineFor({ kind: 'ssh', target });
  if (!known) {
    saveSession();
    void connect(machine);
  } else if (machine.link === 'failed') {
    void connect(machine);
  } else {
    broadcast();
  }
}

function closeMachine(target: string): void {
  const machine = machines.get(target);
  if (!machine || machine.host.kind === 'local') return;
  machine.attempt += 1;
  machine.connection?.close();
  machines.delete(target);
  saveSession();
  broadcast();
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

/* --- the window ----------------------------------------------------------- */

function showWindow(bounds?: Electron.Rectangle): BrowserWindow {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    return mainWindow;
  }
  const window = new BrowserWindow({
    width: 1440, height: 900, ...bounds, minWidth: 720, minHeight: 480, show: false, title: 'Dolphin',
    ...windowChrome(),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  mainWindow = window;
  workspaceShown = false;
  hardenWindow(window);
  window.on('page-title-updated', (event) => event.preventDefault());
  // macOS hides the traffic lights in full screen; the page then reclaims their space.
  window.on('enter-full-screen', () => window.webContents.send('dolphin:fullscreen', true));
  window.on('leave-full-screen', () => window.webContents.send('dolphin:fullscreen', false));
  // Saved while the window still exists, so its place and machines come back.
  window.on('close', () => saveSession());
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
    workspaceShown = false;
    // The helpers and tmux keep running; only this app's links to them go.
    for (const machine of machines.values()) { machine.attempt += 1; machine.connection?.close(); }
    machines.clear();
  });
  void startWorkspace(window);
  return window;
}

/** The launch page until this computer's helper answers, then the workspace. */
async function startWorkspace(window: BrowserWindow): Promise<void> {
  workspaceShown = false;
  await window.loadURL(`app://connect/status.html#${encodeURIComponent('Opening This Computer…')}`);
  window.show();
  const local = machineFor({ kind: 'local' });
  if (local.link !== 'connected') await connect(local);
  if (window.isDestroyed()) return;
  if (local.link !== 'connected') {
    void window.webContents.executeJavaScript(
      `window.setError ? window.setError(${JSON.stringify('Could not open This Computer')}, ${JSON.stringify(local.error ?? '')}) : window.setStatus(${JSON.stringify(local.error ?? '')})`,
    ).catch(() => undefined);
    return;
  }
  await window.loadURL(`${APP_ORIGIN}/desktop.html#/workspace`);
  workspaceShown = true;
  broadcast();
}

// The launch page's buttons after a failure: start this computer's helper
// again, or show its logs.
ipcMain.on('dolphin:retry', (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (window && window === mainWindow) void startWorkspace(window);
});
ipcMain.on('dolphin:open-logs', () => void shell.openPath(path.join(app.getPath('home'), '.dolphin-server', 'logs')));

/* The machines open when Dolphin quits come back at the next launch, in the
   window's last place. */
const sessionFile = () => path.join(app.getPath('userData'), 'session.json');
type Saved = { machines?: string[]; bounds?: Electron.Rectangle; open?: { target: string; bounds?: Electron.Rectangle }[] };
function saveSession(): void {
  const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  let saved: Saved = {};
  try { saved = JSON.parse(readFileSync(sessionFile(), 'utf8')) as Saved; } catch { /* first save */ }
  const state: Saved = {
    machines: [...machines.keys()].filter((id) => id !== 'local'),
    bounds: window ? window.getNormalBounds() : saved.bounds,
  };
  try { writeFileSync(sessionFile(), JSON.stringify(state, null, 2)); } catch { /* restoring is a convenience */ }
}
function restoreSession(): void {
  let saved: Saved = {};
  try { saved = JSON.parse(readFileSync(sessionFile(), 'utf8')) as Saved; } catch { /* first launch */ }
  // Before 0.1.11 each machine had its own window: their machines all come
  // into the one window, which takes the first one's place.
  const targets = (saved.machines ?? (saved.open ?? []).map((item) => item.target))
    .filter((target) => target !== 'local' && validTarget(target));
  const bounds = saved.bounds ?? saved.open?.[0]?.bounds;
  machineFor({ kind: 'local' });
  for (const target of [...new Set(targets)]) machineFor({ kind: 'ssh', target });
  showWindow(bounds);
  for (const machine of machines.values()) if (machine.host.kind === 'ssh') void connect(machine);
}

const machineOf = (target: unknown) => (typeof target === 'string' ? machines.get(target) : undefined);

ipcMain.on('dolphin:machine-list', (event) => { event.returnValue = machineList(); });
// This computer's link, for the launch page.
ipcMain.on('dolphin:connection-state', (event) => {
  const local = machines.get('local');
  event.returnValue = local ? infoOf(local) : null;
});
ipcMain.handle('dolphin:machines', async () => (await detectMachines(app.getPath('userData')))
  .map((machine) => ({ ...machine, open: machines.has(machine.target) })));
ipcMain.handle('dolphin:open-machine', (_event, target: unknown) => {
  if (typeof target !== 'string' || (target !== 'local' && !validTarget(target))) return { error: 'Enter a machine like gpu-box, user@10.0.0.5 or ssh://user@host:2222.' };
  openMachine(target);
  return { ok: true };
});
ipcMain.on('dolphin:close-machine', (_event, target: unknown) => { if (typeof target === 'string') closeMachine(target); });
ipcMain.handle('dolphin:forget-machine', (_event, target: unknown) => {
  if (typeof target === 'string') forgetMachine(app.getPath('userData'), target);
});
ipcMain.on('dolphin:reconnect', (_event, target: unknown) => {
  const machine = machineOf(target);
  if (!machine) return;
  if (machine.link === 'failed' || !machine.connection) void connect(machine);
  else machine.connection.reconnectNow?.(true);
});
ipcMain.handle('dolphin:setup-key', async (_event, target: unknown) => {
  const machine = machineOf(target);
  if (!machine || machine.host.kind !== 'ssh') return { error: 'Only machines reached over SSH sign in.' };
  try {
    await installKey(machine.host.target);
    machine.offerKey = false;
    broadcast();
    return { ok: true };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
});
ipcMain.on('dolphin:dismiss-key', (_event, target: unknown) => {
  const machine = machineOf(target);
  if (machine) { machine.offerKey = false; broadcast(); }
});

/** Connect to a Machine… : the window's own dialog, or a small window while it has none. */
function connectFromMenu(): void {
  if (mainWindow && !mainWindow.isDestroyed() && workspaceShown) {
    showWindow();
    mainWindow.webContents.send('dolphin:connect-open');
  } else {
    openConnectWindow();
  }
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
  // The window's own backend is this computer's helper.
  const local = event.sender === mainWindow?.webContents ? machines.get('local')?.connection : undefined;
  event.returnValue = local ? { apiBase: local.apiBase, token: local.token, host: local.label } : null;
});
ipcMain.handle('dolphin:ssh-hosts', () => sshConfigHosts());
ipcMain.handle('dolphin:connect', async (event, target: unknown) => {
  if (typeof target !== 'string' || !validTarget(target.trim())) return { error: 'Enter a machine like gpu-box, user@10.0.0.5 or ssh://user@host:2222.' };
  const from = BrowserWindow.fromWebContents(event.sender);
  if (from && from !== mainWindow) from.close();
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
  app.on('second-instance', () => { if (mainWindow) showWindow(); });
  app.whenReady().then(() => {
    serveApp();
    setSshEnv(startAskpass());
    startUpdateChecks();
    buildMenu();
    restoreSession();
    // Back from sleep: every machine link tries again at once.
    powerMonitor.on('resume', () => { for (const machine of machines.values()) machine.connection?.reconnectNow?.(false); });
    app.on('activate', () => {
      if (!mainWindow) restoreSession();
    });
  });
  // Drop every relay and SSH forward on quit; open connections must not hold the app open.
  app.on('before-quit', () => saveSession());
  app.on('will-quit', () => {
    for (const machine of machines.values()) machine.connection?.close();
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

