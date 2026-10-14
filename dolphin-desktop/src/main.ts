/* Dolphin Desktop's main process.
 *
 * Every window holds every machine Dolphin works on (File → New Window opens
 * another, each with its own layout): this computer, and any
 * machine added from Connect to a Machine (the projects list, ⌘K, the menu,
 * ⌘/Ctrl+Shift+O), which stays connected: a dropped link comes back by itself
 * (hosts.ts). The machines open when Dolphin last quit come back at launch.
 * The page gets this computer's helper through the preload, and every
 * machine's address and token in the machine list; it is served from the
 * app:// origin, which the helpers' CORS allows. */

import { app, BrowserWindow, BrowserWindowConstructorOptions, crashReporter, ipcMain, Menu, nativeTheme, net, Notification, powerMonitor, protocol, screen, shell } from 'electron';
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { CRASH_DIR, crashReporterOptions } from './crashReports';
import { startAskpass } from './askpass';
import { commandItem, CommandId, keyBindings, newWindowAccelerator } from './keymap';
import { checkFromMenu, startUpdateChecks } from './updates';
import { connectLocal, connectSsh, Connection, fetchRemoteLog, helperDir, HostSpec, installKey, LinkState, setSshEnv, sshConfigHosts } from './hosts';
import { contentSecurityPolicy } from './csp';
import { openableExternally } from './links';
import { isLoopbackUrl, remotePortOf, rewriteToLocal, validPort } from './forwards';
import { DEFAULT_SETTINGS, onSettingsChange, patchIsValid, readRawSettings, readSettings, writeSettings } from './settings';
import { hostNames, issueUrl, tailLines } from './issueReport';
import { memoryChoiceFor, seededMemory, sendMemoryChoice } from './memorySync';
import { LinkSnapshot, nextEpoch } from './link-epoch';
import { detectMachines, forgetMachine, rememberMachine, validTarget } from './machines';
import { explainRemoteError, remoteLogName } from './remote';
import { openFeed, type Feed } from './feed';
import { feedChanges, HeldPopups, isOpenTarget, notificationContent, SeenIds, wantsSystemNotification, type OpenTarget, type TurnNotification } from './notify';
import { applyWindowFlags, windowFlags } from './windowState';
import { Bounds, clampBounds, freeSlot, readJson, Saved, savedSystemNotifications, SavedWindow, secondInstanceAction, sessionToSave, windowsAfterCloses, windowsToRestore, writeJsonAtomic } from './session-store';

const APP_ORIGIN = 'app://dolphin';
const rendererRoot = app.isPackaged
  ? path.join(process.resourcesPath, 'renderer')
  : path.resolve(__dirname, '..', '..', 'dolphin-web', 'dist-desktop');
const staticRoot = path.resolve(__dirname, '..', 'static');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

// Crash reports stay on this computer (crashReports.ts). Started before
// anything else, so an early crash is caught too.
app.setPath('crashDumps', path.join(app.getPath('userData'), CRASH_DIR));
const crashOptions = crashReporterOptions(readSettings(app.getPath('userData')).crashReports);
if (crashOptions) crashReporter.start(crashOptions);

function serveApp(): void {
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    const root = url.hostname === 'connect' ? staticRoot : rendererRoot;
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'desktop.html';
    const file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep)) return new Response('Not found', { status: 404 });
    const response = await net.fetch(pathToFileURL(file).toString());
    if (!file.endsWith('.html') || !response.ok) return response;
    const html = await response.text();
    return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': contentSecurityPolicy(html) } });
  });
}

function hardenWindow(window: BrowserWindow): void {
  // Links open in the user's browser, never inside the app; loopback ones too,
  // except Dolphin's own helper ports.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (openableExternally(url, dolphinPorts())) void shell.openExternal(url);
    return { action: 'deny' };
  });
  // Navigation stays inside app://, whether it starts in the page, in a
  // redirect, or in a frame.
  const stay = (event: { preventDefault(): void }, url: string) => {
    if (!url.startsWith('app://')) event.preventDefault();
  };
  window.webContents.on('will-navigate', stay);
  window.webContents.on('will-redirect', stay);
  window.webContents.on('will-frame-navigate', (event) => {
    // Frames may also show a loopback preview (see csp.ts).
    let allowed = false;
    try {
      const target = new URL(event.url);
      allowed = target.protocol === 'app:' || (target.protocol === 'http:' && target.hostname === '127.0.0.1');
    } catch { /* unparseable: denied */ }
    if (!allowed) event.preventDefault();
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
  /** Why agent forwarding, turned on for this machine, is not working. */
  agentError?: string;
  attempt: number;
  /** Moves when this machine's terminals must reattach (link-epoch.ts). */
  epoch: number;
  seen?: LinkSnapshot;
};
const machines = new Map<string, MachineState>();

/* Every window is the same workspace over the same machines. Each has a number
   (`slot`) that keeps its layout apart from the others' (the page's
   windowScope.ts), and its own load state:
   - shown: the workspace has loaded (until then the launch page shows);
   - localInPage: the page was loaded with this computer's helper in its config;
   - fresh: opened with New Window, so the page starts from an empty layout
     rather than one a closed window with the same number left behind;
   - closing: its close has begun (closeBurst). */
type WindowState = { slot: number; shown: boolean; localInPage: boolean; fresh: boolean; closing: boolean };
const windows = new Map<BrowserWindow, WindowState>();
/** Every window, the one focused most recently last. */
let focusOrder: BrowserWindow[] = [];
const liveWindows = () => focusOrder.filter((window) => !window.isDestroyed() && windows.has(window));
/** The window menus, commands and notifications act on: the focused one, or the one focused last. */
function frontWindow(): BrowserWindow | null {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && windows.has(focused)) return focused;
  return liveWindows().at(-1) ?? null;
}
/** The workspace window a page message came from; never the Connect window. */
function windowOf(sender: Electron.WebContents): BrowserWindow | null {
  const window = BrowserWindow.fromWebContents(sender);
  return window && windows.has(window) ? window : null;
}
/** Quitting saves every window first; the windows closing after that must not shrink the list. */
let quitting = false;
/** Windows closing together (a desktop's Close All, ⌘⌥W, restarting into an
 *  update) are one decision: what was open before the first of them closed is
 *  kept until the closes settle, and saved if none is left open. */
let closeBurst: { before: SavedWindow[]; timer: NodeJS.Timeout } | null = null;
const CLOSES_SETTLE_MS = 500;

/** Agent forwarding is a saved, per-machine choice, off unless turned on. Kept
 *  in memory (every broadcast asks), refreshed by each settings write here. */
let savedForwarding: Record<string, boolean> | null = null;
const agentForwardingMap = () => (savedForwarding ??= readSettings(app.getPath('userData')).agentForwarding);
function saveSettings(patch: unknown) {
  const saved = writeSettings(app.getPath('userData'), patch);
  savedForwarding = saved.agentForwarding;
  return saved;
}
const forwardsAgent = (machine: MachineState) => machine.host.kind === 'ssh' && agentForwardingMap()[machine.host.target] === true;
const idOf = (host: HostSpec) => (host.kind === 'local' ? 'local' : host.target);
const infoOf = (machine: MachineState) => ({
  id: machine.id, kind: machine.host.kind, target: machine.host.kind === 'ssh' ? machine.host.target : null,
  label: machine.host.kind === 'local' ? 'This Computer' : machine.title,
  hostname: machine.connection?.label ?? null,
  state: machine.link, status: machine.status ?? null, error: machine.error ?? null,
  reason: machine.reason ?? null, offerKey: Boolean(machine.offerKey), epoch: machine.epoch,
  agentForwarding: forwardsAgent(machine),
  agentError: machine.agentError ?? null,
  apiBase: machine.link === 'failed' ? null : machine.connection?.apiBase ?? null,
  token: machine.link === 'failed' ? null : machine.connection?.token ?? null,
});
const machineList = () => [...machines.values()].map(infoOf);
/** The loopback ports of this window's relays and SSH forwards. */
const dolphinPorts = () => new Set([...machines.values()]
  .map((machine) => machine.connection?.apiBase)
  .filter((base): base is string => Boolean(base))
  .map((base) => Number(new URL(base).port)));

function noteEpoch(machine: MachineState): void {
  const now: LinkSnapshot = { state: machine.link, token: machine.connection?.token ?? null, apiBase: machine.connection?.apiBase ?? null };
  machine.epoch = nextEpoch(machine.epoch, machine.seen, now);
  machine.seen = now;
}

function broadcast(): void {
  for (const machine of machines.values()) noteEpoch(machine);
  // Every link change, connect, token or address change and removal passes here.
  syncFeeds();
  const list = machineList();
  const local = machines.get('local');
  for (const window of liveWindows()) {
    if (windows.get(window)?.shown) window.webContents.send('dolphin:machines', list);
    // Still on the launch page: it shows this computer's progress.
    else if (local?.status) void window.webContents.executeJavaScript(`window.setStatus && window.setStatus(${JSON.stringify(local.status)})`).catch(() => undefined);
  }
}

/* --- notifications -------------------------------------------------------- */

/* Finished turns. The main process listens to every connected machine's
   notification stream itself, so they arrive while the window is unfocused,
   hidden or (macOS) closed. The page's bell and pop-ups cover a focused
   window; a system notification covers the rest. */
const feeds = new Map<string, { key: string; feed: Feed }>();
const announced = new SeenIds(500);
const popups = new HeldPopups<Notification>();
/** The page's setting, kept in session.json so an off setting holds from launch. */
let systemNotifications = true;
/** A session to open, waiting for `window` (a BrowserWindow id) to take it, or any window when null. */
let pendingOpen: { target: OpenTarget; at: number; window: number | null } | null = null;

/** One stream per connected machine. It restarts when the machine's address,
 *  token or epoch moves (a recovered link may come back on a new relay), and
 *  stops when the machine drops, fails, closes or is forgotten. */
function syncFeeds(): void {
  const wanted = new Map<string, string>();
  for (const machine of machines.values()) {
    if (machine.link === 'connected' && machine.connection) wanted.set(machine.id, `${machine.connection.apiBase} ${machine.connection.token} ${machine.epoch}`);
  }
  const { stop, start } = feedChanges(new Map([...feeds].map(([id, entry]) => [id, entry.key])), wanted);
  for (const id of stop) { feeds.get(id)?.feed.stop(); feeds.delete(id); }
  for (const id of start) {
    const machine = machines.get(id);
    const connection = machine?.connection;
    if (!machine || !connection) continue;
    feeds.set(id, { key: wanted.get(id)!, feed: openFeed({
      url: `${connection.apiBase}/api/notifications/stream`, token: connection.token,
      onNotification: (item) => announceTurn(machine, item),
    }) });
  }
}

function stopFeeds(): void {
  for (const entry of feeds.values()) entry.feed.stop();
  feeds.clear();
}

function announceTurn(machine: MachineState, item: TurnNotification): void {
  if (machines.get(machine.id) !== machine) return;
  if (!announced.add(`${machine.id} ${item.id}`)) return;
  const content = notificationContent(item, machine.host.kind === 'ssh' ? machine.title : null, process.platform);
  showSystemNotification(content, item.project_id ? { machine: machine.id, projectId: item.project_id, session: item.session_name } : null);
}

function showSystemNotification(content: { title: string; body: string; subtitle?: string }, target: OpenTarget | null): void {
  const focused = BrowserWindow.getFocusedWindow();
  // A focused window shows its own pop-ups, and the session in view needs none.
  if (!wantsSystemNotification({ enabled: systemNotifications, windowFocused: Boolean(focused && windows.has(focused)) })) return;
  if (!Notification.isSupported()) return;
  const popup = new Notification({ title: content.title, body: content.body, ...(content.subtitle ? { subtitle: content.subtitle } : {}) });
  popups.hold(popup); // so its click handler is not collected; released on click, close or a 10-minute timeout
  popup.on('click', () => {
    popups.release(popup);
    if (liveWindows().length) focusWindow();
    else reopenWindow();
    if (target) openSession(target);
  });
  popup.on('close', () => popups.release(popup));
  popup.show();
  // Arrival asks for attention: the dock bounces once (macOS), the taskbar entry flashes elsewhere.
  if (process.platform === 'darwin') app.dock?.bounce('informational');
  else frontWindow()?.flashFrame(true);
}

/** The front window's page takes the target (preload `onOpenSession`); a
 *  window still loading takes it once it loads. */
function openSession(target: OpenTarget): void {
  const window = frontWindow();
  pendingOpen = { target, at: Date.now(), window: window?.id ?? null };
  if (window && windows.get(window)?.shown) window.webContents.send('dolphin:open-session');
}

ipcMain.on('dolphin:take-open-session', (event) => {
  const window = windowOf(event.sender);
  if (!window || !pendingOpen || (pendingOpen.window !== null && pendingOpen.window !== window.id)) { event.returnValue = null; return; }
  event.returnValue = Date.now() - pendingOpen.at < 60_000 ? pendingOpen.target : null;
  pendingOpen = null;
});
ipcMain.on('dolphin:notify', (event, payload: unknown) => {
  if (!windowOf(event.sender)) return;
  if (!payload || typeof payload !== 'object') return;
  const { title, body, machine, projectId, session } = payload as Record<string, unknown>;
  if (typeof title !== 'string' || typeof body !== 'string') return;
  const target = { machine, projectId, session };
  showSystemNotification({ title: title.slice(0, 200), body: body.slice(0, 500) }, isOpenTarget(target) ? target : null);
});
ipcMain.on('dolphin:system-notifications', (event, enabled: unknown) => {
  if (!windowOf(event.sender) || typeof enabled !== 'boolean') return;
  if (enabled === systemNotifications) return;
  systemNotifications = enabled;
  const saved = readJson<Saved>(sessionFile(), {});
  try { writeJsonAtomic(sessionFile(), { ...saved, systemNotifications: enabled }); } catch { /* kept for this run */ }
});

function machineFor(host: HostSpec): MachineState {
  const id = idOf(host);
  let machine = machines.get(id);
  if (!machine) {
    machine = { host, id, title: host.kind === 'local' ? 'This Computer' : host.target, link: 'connecting', attempt: 0, epoch: 0 };
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
  machine.agentError = undefined;
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
    tellMemory(machine, 'connected');
    if (machine.host.kind === 'local') {
      // A page read its helper's address at load, when it had none.
      for (const window of liveWindows()) {
        const state = windows.get(window);
        if (!state?.shown || state.localInPage) continue;
        state.localInPage = true;
        window.webContents.reload();
      }
    }
    if (machine.host.kind === 'ssh') {
      rememberMachine(app.getPath('userData'), machine.host.target);
      machine.offerKey = connection.usedPassword;
    }
    // Every link, this computer's included, reports drops and comebacks.
    connection.watch?.((link, info) => {
      if (!current()) return;
      machine.link = link;
      machine.reason = info.reason;
      // A machine over SSH with a new token reaches the page as a new token
      // in the list; this computer's token is the page's own config, read at load.
      if (machine.host.kind === 'local' && info.tokenChanged) for (const window of liveWindows()) window.webContents.reload();
      broadcast();
    });
    connection.watchAgent?.((error) => {
      if (!current() || !forwardsAgent(machine)) return;
      machine.agentError = error;
      broadcast();
    });
    if (forwardsAgent(machine)) {
      void connection.setAgentForwarding?.(true).then((result) => {
        if (!current() || !forwardsAgent(machine)) return;
        machine.agentError = result.error;
        broadcast();
      });
    }
  } catch (error) {
    if (!current()) return;
    machine.link = 'failed';
    machine.status = undefined;
    machine.error = machine.host.kind === 'ssh' ? explainRemoteError(machine.host.target, error) : error instanceof Error ? error.message : String(error);
  }
  broadcast();
}

/** Add a machine to the windows, or bring back one that failed. */
function openMachine(target: string): void {
  if (liveWindows().length) focusWindow();
  else reopenWindow();
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

const dolphinHome = () => process.env.DOLPHIN_HOME || path.join(app.getPath('home'), '.dolphin-server');

/** Memory follows the user's choice on every machine (memorySync.ts). Never
 *  awaited by connect(); a failure waits for the next connect, no retry loop. */
function tellMemory(machine: MachineState, event: 'connected' | 'changed'): void {
  const choice = memoryChoiceFor(event, readSettings(app.getPath('userData')).memory);
  const connection = machine.connection;
  if (choice === null || !connection || machine.link !== 'connected') return;
  void sendMemoryChoice(connection.apiBase, connection.token, choice, (url, init) => net.fetch(url, { ...init, signal: AbortSignal.timeout(15_000) }))
    .catch(() => undefined);
}

/** `ssh -G <alias>`'s hostname and user, or nothing: never waits more than 2 s. */
function resolveSsh(alias: string): Promise<{ host: string; user: string }> {
  return new Promise((resolve) => {
    if (!alias || alias.startsWith('-')) { resolve({ host: '', user: '' }); return; }
    try {
      execFile('ssh', ['-G', alias], { timeout: 2000, maxBuffer: 256 * 1024 }, (error, stdout) => {
        const field = (name: string) => (error ? '' : new RegExp(`^${name} (\\S+)$`, 'm').exec(String(stdout))?.[1] ?? '');
        resolve({ host: field('hostname'), user: field('user') });
      });
    } catch { resolve({ host: '', user: '' }); }
  });
}

/** Help → Report an Issue…: a pre-filled GitHub issue, scrubbed (issueReport.ts).
 *  It opens in the browser for the user to read and submit; nothing is sent. */
async function reportIssue(): Promise<void> {
  const local = machines.get('local')?.connection;
  let environment: { helper_version?: string; tmux?: { version: string | null; bundled: boolean } } = {};
  if (local) {
    try {
      const response = await net.fetch(`${local.apiBase}/api/desktop/environment`, { headers: { 'X-Dolphin-Token': local.token }, signal: AbortSignal.timeout(3000) });
      if (response.ok) environment = await response.json() as typeof environment;
    } catch { /* an older or stopped helper: report without it */ }
  }
  const ssh = [...machines.values()].filter((machine) => machine.host.kind === 'ssh');
  // A target is "user@host", "host", "ssh://user@host:port" or an alias from ~/.ssh/config.
  const parts = (target: string) => {
    const bare = target.replace(/^ssh:\/\//, '').replace(/:\d+$/, '');
    const at = bare.lastIndexOf('@');
    return { user: at >= 0 ? bare.slice(0, at) : '', host: bare.slice(at + 1) };
  };
  const targets = ssh.map((machine) => parts(machine.host.kind === 'ssh' ? machine.host.target : ''));
  // What ssh itself resolves the alias to (HostName, User): another name the log may carry.
  const resolved = await Promise.all(targets.map((target) => resolveSsh(target.host)));
  const url = issueUrl({
    appVersion: app.getVersion(),
    channel: readSettings(app.getPath('userData')).updateChannel,
    platform: process.platform, osRelease: os.release(), arch: process.arch,
    helperVersion: environment.helper_version ?? null, tmux: environment.tmux ?? null,
    sshMachines: ssh.length,
    logLines: tailLines(path.join(dolphinHome(), 'logs', 'helper.log'), 40),
  }, {
    home: os.homedir(),
    user: os.userInfo().username,
    users: [...targets.map((target) => target.user), ...resolved.map((entry) => entry.user)],
    hostnames: [...hostNames(os.hostname()),
      ...targets.flatMap((target) => hostNames(target.host)),
      ...resolved.flatMap((entry) => hostNames(entry.host)),
      ...ssh.flatMap((machine) => [machine.title, machine.connection?.label ?? ''].flatMap(hostNames))],
    secrets: [...machines.values()].map((machine) => machine.connection?.token ?? ''),
  });
  await shell.openExternal(url);
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

/* --- the windows ---------------------------------------------------------- */

/** Bring the front window forward. */
function focusWindow(): BrowserWindow | null {
  const window = frontWindow();
  if (!window) return null;
  if (window.isMinimized()) window.restore();
  if (!window.isVisible()) window.show();
  window.focus();
  return window;
}

const workAreas = () => screen.getAllDisplays().map((display) => display.workArea);

/** One workspace window, in `place`. It shows the launch page until this
 *  computer's helper is up, then the workspace. */
function createWindow(place: SavedWindow, fresh = false): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440, height: 900, ...place.bounds, minWidth: 720, minHeight: 480, show: false,
    title: place.slot === 1 ? 'Dolphin' : `Dolphin (${place.slot})`,
    ...windowChrome(),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const state: WindowState = { slot: place.slot, shown: false, localInPage: false, fresh, closing: false };
  windows.set(window, state);
  focusOrder.push(window);
  hardenWindow(window);
  window.on('focus', () => {
    // A notification flashed the taskbar entry (Linux, Windows); looking stops it.
    window.flashFrame(false);
    focusOrder = [...focusOrder.filter((other) => other !== window), window];
  });
  window.on('page-title-updated', (event) => event.preventDefault());
  // macOS hides the traffic lights in full screen; the page then reclaims their space.
  window.on('enter-full-screen', () => window.webContents.send('dolphin:fullscreen', true));
  window.on('leave-full-screen', () => window.webContents.send('dolphin:fullscreen', false));
  // The workspace counts as shown once its page has loaded, however it got
  // there (a reload included), and not while the launch page shows.
  window.webContents.on('did-finish-load', () => {
    if (!window.webContents.getURL().startsWith(`${APP_ORIGIN}/desktop.html`)) return;
    // A reload from here on keeps the layout this window has made.
    state.fresh = false;
    if (state.shown) return;
    state.shown = true;
    broadcast();
  });
  // Closing one of several windows forgets it; closing the last, or all of
  // them at once, keeps them for next time (windowsAfterCloses).
  window.on('close', () => {
    if (quitting || state.closing) return;
    const before = closeBurst?.before ?? openPlaces();
    if (closeBurst) clearTimeout(closeBurst.timer);
    state.closing = true;
    closeBurst = { before, timer: setTimeout(settleCloses, CLOSES_SETTLE_MS) };
  });
  window.on('closed', () => {
    windows.delete(window);
    focusOrder = focusOrder.filter((other) => other !== window);
    // A session waiting for this window goes to whichever window is in front.
    if (pendingOpen?.window === window.id) {
      const front = frontWindow();
      pendingOpen.window = null;
      if (front && windows.get(front)?.shown) front.webContents.send('dolphin:open-session');
    }
    // The machine links stay up while Dolphin runs (macOS keeps it running
    // with no window), so finished turns still raise notifications, and
    // quitting later saves the machines that were open.
  });
  void startWorkspace(window, place);
  return window;
}

/** File → New Window (and the Dock menu, ⌘K, --new-window): another workspace
 *  over the same machines, a step down and right of the front one, with an
 *  empty layout. With no window open it is the same as reopening Dolphin. */
function newWindow(): void {
  const front = frontWindow();
  if (!front) { reopenWindow(); return; }
  const from = front.isFullScreen() || front.isMaximized() ? undefined : front.getNormalBounds();
  const bounds = from ? clampBounds({ ...from, x: from.x + 28, y: from.y + 28 }, workAreas()) : undefined;
  const slot = freeSlot([...windows.values()].map((state) => state.slot));
  createWindow({ slot, bounds, maximized: false, fullScreen: false }, true);
}

/** This computer's helper, started once however many windows wait for it. A
 *  link that is up, or recovering by itself, is left alone. */
let localStarting: Promise<void> | null = null;
function startLocal(): Promise<void> {
  const local = machineFor({ kind: 'local' });
  if (local.connection && local.link !== 'failed') return Promise.resolve();
  return (localStarting ??= connect(local).finally(() => { localStarting = null; }));
}

/** The launch page while this computer's helper starts, then the workspace,
 *  whether or not it started: a failed helper shows as a failed section with
 *  Reconnect, and machines over SSH work regardless. */
async function startWorkspace(window: BrowserWindow, flags: { maximized?: boolean; fullScreen?: boolean } = {}): Promise<void> {
  const state = windows.get(window);
  if (!state) return;
  state.shown = false;
  // A load cut short (the window closed, or reloaded as this computer's helper
  // came back) is not an error: did-finish-load marks the workspace shown.
  const load = (url: string) => window.loadURL(url).then(() => true, () => false);
  await load(`app://connect/status.html#${encodeURIComponent('Opening This Computer…')}`);
  if (window.isDestroyed()) return;
  window.show();
  applyWindowFlags(window, flags);
  await startLocal();
  if (window.isDestroyed()) return;
  state.localInPage = Boolean(machines.get('local')?.connection);
  await load(`${APP_ORIGIN}/desktop.html#/workspace`);
}

// The launch page's buttons after a failure: start this computer's helper
// again, or show its logs.
ipcMain.on('dolphin:retry', (event) => {
  const window = windowOf(event.sender);
  if (window) void startWorkspace(window);
});
ipcMain.on('dolphin:open-logs', () => void shell.openPath(path.join(app.getPath('home'), '.dolphin-server', 'logs')));
// Which window the page is, for its layout (windowScope.ts), and New Window from ⌘K.
ipcMain.on('dolphin:window', (event) => {
  const window = windowOf(event.sender);
  const state = window ? windows.get(window) : undefined;
  event.returnValue = state ? { slot: state.slot, fresh: state.fresh } : null;
});
ipcMain.on('dolphin:new-window', (event) => { if (windowOf(event.sender)) newWindow(); });

/* The machines and windows open when Dolphin quits come back at the next
   launch, each window in its last place with its own layout. */
const sessionFile = () => path.join(app.getPath('userData'), 'session.json');
/** Each open window's number and place, the front one last; none that is closing. */
function openPlaces(): SavedWindow[] {
  return liveWindows()
    .filter((window) => !windows.get(window)!.closing)
    .map((window) => ({ slot: windows.get(window)!.slot, bounds: window.getNormalBounds(), ...windowFlags(window) }));
}
function settleCloses(): void {
  const burst = closeBurst;
  closeBurst = null;
  if (burst && !quitting) saveSession(windowsAfterCloses(burst.before, openPlaces()));
}
/** `kept`: the windows to save; by default those open, or while closes are
 *  settling, those open before they began. None (macOS with no window) keeps
 *  the saved ones. */
function saveSession(kept: SavedWindow[] = closeBurst?.before ?? openPlaces()): void {
  const front = kept.at(-1);
  // The live machines, window or not: with no window (macOS) they are still connected.
  const state = sessionToSave(readJson<Saved>(sessionFile(), {}), {
    machines: [...machines.keys()].filter((id) => id !== 'local'),
    bounds: front?.bounds,
    flags: front ? { maximized: front.maximized, fullScreen: front.fullScreen } : undefined,
    windows: kept.length ? kept : undefined,
  });
  try { writeJsonAtomic(sessionFile(), state); } catch { /* restoring is a convenience */ }
}
/** The saved windows, each on a screen that is attached, the front one opened last. */
function openSavedWindows(saved: Saved): void {
  const areas = workAreas();
  for (const place of windowsToRestore(saved)) createWindow({ ...place, bounds: clampBounds(place.bounds, areas) as Bounds | undefined });
}
/** Windows again when there are none (macOS activate, a second launch, a
 *  machine or notification opened with no window): the live machines are
 *  still connected, so they just get windows; only with none is the saved
 *  session restored (which adds and connects its machines). */
function reopenWindow(): void {
  if (liveWindows().length) { focusWindow(); return; }
  if (machines.size) openSavedWindows(readJson<Saved>(sessionFile(), {}));
  else restoreSession();
}
function restoreSession(): void {
  const saved = readJson<Saved>(sessionFile(), {});
  // Before 0.1.11 each machine had its own window: their machines all come
  // into the one window.
  const targets = (saved.machines ?? (saved.open ?? []).map((item) => item.target))
    .filter((target) => typeof target === 'string' && target !== 'local' && validTarget(target));
  machineFor({ kind: 'local' });
  for (const target of [...new Set(targets)]) machineFor({ kind: 'ssh', target });
  openSavedWindows(saved);
  for (const machine of machines.values()) if (machine.host.kind === 'ssh') void connect(machine);
}

const machineOf = (target: unknown) => (typeof target === 'string' ? machines.get(target) : undefined);

/** Where this computer's browser reaches `url` on `machine`: a forwarded
 *  local port for a loopback address on a machine reached over SSH, or the URL
 *  itself (on this computer, or for any host but loopback), which then passes
 *  the same rule as any link from the page (links.ts) so Dolphin's own relay
 *  and forward ports never open in a browser. */
async function localUrlFor(machine: MachineState | undefined, url: string): Promise<string> {
  if (!machine || machine.host.kind === 'local' || !isLoopbackUrl(url)) {
    if (!openableExternally(url, dolphinPorts())) throw new Error('That address belongs to Dolphin and does not open in a browser.');
    return url;
  }
  const connection = machine.connection;
  if (!connection?.forwardPort || machine.link !== 'connected') throw new Error(`${machine.title} is not connected.`);
  return rewriteToLocal(url, await connection.forwardPort(remotePortOf(new URL(url))));
}

async function openOnThisComputer(machineId: unknown, url: string): Promise<{ url?: string; error?: string }> {
  // This Computer may be absent from the map (its helper failed); any other
  // machine must be open in this window, or its localhost would be ours.
  const machine = machineOf(machineId);
  if (!machine && machineId !== 'local') return { error: 'That machine is not in this window.' };
  try {
    const local = await localUrlFor(machine, url);
    await shell.openExternal(local);
    return { url: local };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

ipcMain.handle('dolphin:open-port', (event, machineId: unknown, port: unknown) => {
  if (!windowOf(event.sender)) return { error: 'Not from this window.' };
  if (typeof port !== 'number' || !validPort(port)) return { error: 'That is not a TCP port.' };
  return openOnThisComputer(machineId, `http://localhost:${port}/`);
});
ipcMain.handle('dolphin:open-url', (event, machineId: unknown, url: unknown) => {
  if (!windowOf(event.sender)) return { error: 'Not from this window.' };
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return { error: 'Only web links open from here.' };
  return openOnThisComputer(machineId, url);
});

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
// "Forward SSH agent" in a machine's menu: saved per machine, applied to its link now.
ipcMain.handle('dolphin:agent-forwarding', async (event, target: unknown, on: unknown) => {
  if (!windowOf(event.sender)) return { error: 'Not from this window.' };
  const machine = machineOf(target);
  if (!machine || machine.host.kind !== 'ssh' || typeof on !== 'boolean') return { error: 'Only machines reached over SSH forward an agent.' };
  saveSettings({ agentForwarding: { ...agentForwardingMap(), [machine.host.target]: on } });
  machine.agentError = undefined;
  broadcast();
  const result = (await machine.connection?.setAgentForwarding?.(on)) ?? { ok: true as const };
  // A later toggle (or a disconnect) owns the state now.
  if (machines.get(machine.id) === machine && forwardsAgent(machine) === on) {
    machine.agentError = result.error;
    broadcast();
  }
  return result;
});
ipcMain.on('dolphin:dismiss-key', (_event, target: unknown) => {
  const machine = machineOf(target);
  if (machine) { machine.offerKey = false; broadcast(); }
});

// "Show Remote Log" in a machine's menu: its helper log, saved and opened here.
ipcMain.handle('dolphin:remote-log', async (_event, target: unknown) => {
  const machine = machineOf(target);
  if (!machine || machine.host.kind !== 'ssh') return { error: 'Only machines reached over SSH have a remote log.' };
  try {
    const text = await fetchRemoteLog(machine.host.target);
    const dir = path.join(app.getPath('userData'), 'remote-logs');
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, remoteLogName(machine.host.target));
    writeFileSync(file, text);
    if (!process.env.DOLPHIN_DESKTOP_TEST_NO_OPEN) void shell.openPath(file);
    return { ok: true, file };
  } catch (error) {
    return { error: explainRemoteError(machine.host.target, error) };
  }
});

/** Connect to a Machine… : the front window's own dialog, or a small window while there is none. */
function connectFromMenu(): void {
  const window = frontWindow();
  if (window && windows.get(window)?.shown) {
    focusWindow();
    window.webContents.send('dolphin:connect-open');
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
  const local = windowOf(event.sender) ? machines.get('local')?.connection : undefined;
  event.returnValue = local ? { apiBase: local.apiBase, token: local.token, host: local.label } : null;
});
// Desktop settings (settings.ts): the page reads them synchronously at start.
// A patch with any invalid value is rejected whole, not partly applied.
ipcMain.on('dolphin:settings-get', (event) => {
  event.returnValue = windowOf(event.sender) ? readSettings(app.getPath('userData')) : { ...DEFAULT_SETTINGS, agentForwarding: {} };
});
ipcMain.handle('dolphin:settings-set', (event, patch: unknown) => {
  const dir = app.getPath('userData');
  if (!windowOf(event.sender) || !patchIsValid(patch)) return readSettings(dir);
  return saveSettings(patch);
});
ipcMain.handle('dolphin:ssh-hosts', () => sshConfigHosts());
ipcMain.handle('dolphin:connect', async (event, target: unknown) => {
  if (typeof target !== 'string' || !validTarget(target.trim())) return { error: 'Enter a machine like gpu-box, user@10.0.0.5 or ssh://user@host:2222.' };
  const from = BrowserWindow.fromWebContents(event.sender);
  if (from && !windows.has(from)) from.close();
  openMachine(target.trim());
  return { ok: true };
});
ipcMain.on('dolphin:badge', (_event, count: unknown) => {
  if (typeof count === 'number' && Number.isFinite(count)) app.setBadgeCount(Math.max(0, Math.floor(count)));
});

/** Every machine link checks itself now (waking up, the network changing).
 *  Reconnect semantics are unchanged: a link in recovery is woken. */
function checkAllLinks(): void {
  for (const machine of machines.values()) machine.connection?.reconnectNow?.(false);
}
ipcMain.on('dolphin:network-changed', () => checkAllLinks());

/** A keyboard command for the front window's workspace; ignored while its launch page shows. */
function sendCommand(id: CommandId): void {
  const window = frontWindow();
  if (!window || !windows.get(window)?.shown) return;
  window.webContents.send('dolphin:command', id);
}

function buildMenu(): void {
  const mac = process.platform === 'darwin';
  const keys = keyBindings(process.platform);
  const command = (id: CommandId) => commandItem(keys, id, sendCommand);
  const separator = { type: 'separator' as const };
  const checkUpdates = { label: 'Check for Updates…', click: () => void checkFromMenu(BrowserWindow.getFocusedWindow() ?? undefined) };
  // Ctrl+R is reverse-i-search in a shell; only macOS keeps a reload key.
  const reload: Electron.MenuItemConstructorOptions = { id: 'reload', label: 'Reload', ...(mac ? { accelerator: 'Cmd+R' } : {}), click: () => frontWindow()?.webContents.reload() };
  const openWindow: Electron.MenuItemConstructorOptions = { id: 'new-window', label: 'New Window', accelerator: newWindowAccelerator(process.platform), click: () => newWindow() };
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(mac ? [{
      label: app.name,
      submenu: [
        { role: 'about' as const }, checkUpdates, separator, command('settings'), separator,
        { role: 'services' as const }, separator,
        { role: 'hide' as const }, { role: 'hideOthers' as const }, { role: 'unhide' as const }, separator,
        { role: 'quit' as const },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        openWindow,
        command('new-session'),
        { label: 'Connect to Machine…', accelerator: 'CmdOrCtrl+Shift+O', click: connectFromMenu },
        separator,
        // Ctrl+Shift+W closes a window in GNOME Terminal too; plain Ctrl+W is delete-word.
        ...(mac ? [command('close-view'), { role: 'close' as const, accelerator: 'Cmd+Shift+W' }] : [{ role: 'close' as const, label: 'Close Window', accelerator: 'Ctrl+Shift+W' }, separator, command('settings'), separator, { role: 'quit' as const }]),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, separator,
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }, separator,
        command('find'),
      ],
    },
    {
      label: 'View',
      submenu: [
        command('palette'), separator,
        command('zoom-in'), command('zoom-out'), command('zoom-reset'), separator,
        reload, { role: 'toggleDevTools' }, { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Go',
      submenu: [command('prev-tab'), command('next-tab'), separator, ...Array.from({ length: 9 }, (_, index) => command(`session-${index + 1}` as CommandId))],
    },
    // Off macOS the stock Window menu's Close carries Ctrl+W, readline's delete-word.
    mac ? { role: 'windowMenu' } : { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }] },
    { role: 'help', submenu: [
      ...(mac ? [] : [checkUpdates]),
      { label: 'Dolphin Logs', click: () => void shell.openPath(path.join(app.getPath('home'), '.dolphin-server', 'logs')) },
      { type: 'separator' as const },
      { label: 'Report an Issue…', click: () => void reportIssue() },
      { label: 'Show Crash Reports', click: () => {
        const dir = app.getPath('crashDumps');
        try { mkdirSync(dir, { recursive: true }); } catch { /* openPath says why */ }
        void shell.openPath(dir);
      } },
    ] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  // Right-clicking Dolphin in the Dock offers New Window too.
  if (mac) app.dock?.setMenu(Menu.buildFromTemplate([{ label: 'New Window', click: () => newWindow() }]));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const action = secondInstanceAction(app.isReady(), liveWindows().length > 0, argv);
    if (action === 'show') focusWindow();
    else if (action === 'restore') reopenWindow();
    else if (action === 'new-window') newWindow();
  });
  app.whenReady().then(() => {
    serveApp();
    setSshEnv(startAskpass());
    startUpdateChecks();
    buildMenu();
    systemNotifications = savedSystemNotifications(readJson<Saved>(sessionFile(), {}));
    // 0.1.x set memory up unasked: a computer that has it starts with the setting on.
    let brainState: string | null = null;
    try { brainState = readFileSync(path.join(dolphinHome(), 'gbrain', 'state.json'), 'utf8'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('Could not read the memory state:', error);
    }
    const seeded = seededMemory(readRawSettings(app.getPath('userData')), brainState);
    if (seeded !== null) writeSettings(app.getPath('userData'), { memory: seeded });
    onSettingsChange((next, previous) => {
      if (next.memory !== previous.memory) for (const machine of machines.values()) tellMemory(machine, 'changed');
    });
    restoreSession();
    // Back from sleep: every machine link tries again at once.
    powerMonitor.on('resume', checkAllLinks);
    app.on('activate', () => {
      // macOS: the windows were closed; their machines are still connected.
      if (!liveWindows().length) reopenWindow();
    });
  });
  // Drop every relay and SSH forward on quit; open connections must not hold the app open.
  app.on('before-quit', () => {
    if (quitting) return;
    // Windows already closing (restarting into an update closes them first)
    // are saved as they were before.
    saveSession();
    if (closeBurst) clearTimeout(closeBurst.timer);
    closeBurst = null;
    quitting = true;
  });
  app.on('will-quit', () => {
    stopFeeds();
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

