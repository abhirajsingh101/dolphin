/* Dolphin Desktop's main process.
 *
 * Opens straight into this computer's workspace on launch. Connect to Machine
 * (menu, ⌘/Ctrl+Shift+O) opens another window for an SSH host. Each window
 * gets the address and token of its own helper through the preload; the
 * renderer is served from the app:// origin, which the helper's CORS allows. */

import { app, BrowserWindow, BrowserWindowConstructorOptions, ipcMain, Menu, nativeTheme, net, protocol, shell } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { startAskpass } from './askpass';
import { connectLocal, connectSsh, Connection, helperDir, HostSpec, setSshEnv, sshConfigHosts } from './hosts';

const APP_ORIGIN = 'app://dolphin';
const rendererRoot = app.isPackaged
  ? path.join(process.resourcesPath, 'renderer')
  : path.resolve(__dirname, '..', '..', 'dolphin-web', 'dist-desktop');
const staticRoot = path.resolve(__dirname, '..', 'static');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

type WindowState = { connection?: Connection; host: HostSpec; title: string };
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

async function openHost(host: HostSpec, from?: BrowserWindow): Promise<void> {
  const title = host.kind === 'local' ? 'This Computer' : host.target;
  const window = from ?? new BrowserWindow({
    width: 1440, height: 900, minWidth: 720, minHeight: 480, show: false, title: `Dolphin — ${title}`,
    ...windowChrome(),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  hardenWindow(window);
  // The title names the machine this window works on; pages don't override it.
  window.on('page-title-updated', (event) => event.preventDefault());
  // macOS hides the traffic lights in full screen; the page then reclaims their space.
  window.on('enter-full-screen', () => window.webContents.send('dolphin:fullscreen', true));
  window.on('leave-full-screen', () => window.webContents.send('dolphin:fullscreen', false));
  const state: WindowState = { host, title };
  // Read the id now: by 'closed', webContents is destroyed and touching it throws,
  // which stalled the app's quit.
  const id = window.webContents.id;
  windows.set(id, state);
  window.on('closed', () => {
    state.connection?.close();
    windows.delete(id);
  });
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
    await window.loadURL(`${APP_ORIGIN}/desktop.html#/workspace`);
  } catch (error) {
    status(`Could not open ${title}: ${error instanceof Error ? error.message : String(error)}`);
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
  const state = windows.get(event.sender.id);
  event.returnValue = state?.connection
    ? { apiBase: state.connection.apiBase, token: state.connection.token, host: state.connection.label }
    : null;
});
ipcMain.handle('dolphin:ssh-hosts', () => sshConfigHosts());
ipcMain.handle('dolphin:connect', async (event, target: unknown) => {
  if (typeof target !== 'string' || !/^[A-Za-z0-9._@:-]{1,253}$/.test(target)) return { error: 'Enter a host like gpu-box or user@10.0.0.5.' };
  BrowserWindow.fromWebContents(event.sender)?.close();
  await openHost({ kind: 'ssh', target });
  return { ok: true };
});
ipcMain.on('dolphin:badge', (_event, count: unknown) => {
  if (typeof count === 'number' && Number.isFinite(count)) app.setBadgeCount(Math.max(0, Math.floor(count)));
});

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Window for This Computer', accelerator: 'CmdOrCtrl+Shift+N', click: () => void openHost({ kind: 'local' }) },
        { label: 'Connect to Machine…', accelerator: 'CmdOrCtrl+Shift+O', click: openConnectWindow },
        { type: 'separator' },
        process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    { role: 'help', submenu: [{ label: 'Dolphin Logs', click: () => void shell.openPath(path.join(app.getPath('home'), '.dolphin-server', 'logs')) }] },
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
    buildMenu();
    void openHost({ kind: 'local' });
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) void openHost({ kind: 'local' });
    });
  });
  // Drop every relay and SSH forward on quit; open connections must not hold the app open.
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

