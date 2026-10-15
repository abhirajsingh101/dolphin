/* Keeping Dolphin up to date.
 *
 * Releases are GitHub releases tagged desktop-vX.Y.Z. Dolphin checks quietly:
 * ten seconds after it starts, every hour, and when the computer wakes or a
 * window comes back to the front after half an hour without a check. A check
 * on demand comes from the About panel (the Dolphin logo, or ⌘K), from
 * Settings → Updates, and from Check for Updates… in the menu. What happens next depends on how it was
 * installed:
 *
 * - AppImage, and a signed Mac app: electron-updater downloads the update in
 *   the background; the user restarts when it suits them ("Restart to Update").
 * - A Mac app without a Developer ID does the same through macUpdate.ts
 *   (electron-updater installs only into a Developer ID signed one), unless
 *   it cannot replace itself: run from the disk image or a translocated copy,
 *   or in a folder it cannot write. That one offers the download, and says why.
 * - .deb and .rpm: the app offers the matching installer ("Download"); they
 *   belong to the system's package manager.
 *
 * The update channel (settings.ts: updateChannel) decides which releases count:
 * stable sees only full releases, beta sees GitHub prereleases too. Changing it
 * checks again at once.
 *
 * Windows hear every change (dolphin:update) and show it as a pill in the
 * header only when there is something to do, never as a dialog. A quiet check
 * that fails (offline, rate limited) shows nothing; one the user asked for
 * says why. After an update, the first window says what is new, once. The helper
 * follows on its own: a newer app brings a newer helper, which replaces the old
 * one when it starts (app/helper.py), on this computer and on SSH machines.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, net, powerMonitor, shell } from 'electron';
import { canSelfUpdate, Channel, compareVersions, dropStagedUpdate, installerFor, linuxPackage, pickRelease, Release, StagedUpdater, tagVersion, updateFilesChannel } from './releases';
import { onSettingsChange, readSettings } from './settings';
import { appBundleOf, downloadVerified, inPlaceBlocker, macZipFor, parseMacFeed, startSwap, unpackUpdate } from './macUpdate';

// The list, not /releases/latest: GitHub's "latest" never names a prerelease,
// and the beta channel needs them (pickRelease chooses per channel).
export const RELEASES = 'https://api.github.com/repos/abhirajsingh101/dolphin/releases?per_page=30';
const DOWNLOADS = 'https://github.com/abhirajsingh101/dolphin/releases/download';
const FIRST_CHECK_MS = 10_000;
const EVERY_MS = 60 * 60 * 1000;
const STALE_MS = 30 * 60 * 1000;
const notesFor = (version: string) => `https://github.com/abhirajsingh101/dolphin/releases/tag/desktop-v${version}`;

type Found =
  | { state: 'idle' | 'checking' | 'current' }
  | { state: 'available'; version: string; action: 'download'; url: string; notesUrl: string; note?: string }
  | { state: 'downloading'; version: string; percent: number; notesUrl: string }
  | { state: 'ready'; version: string; action: 'restart'; notesUrl: string }
  | { state: 'error'; message: string };
/** What windows see: what was found, this app's version, and when a check last succeeded. */
export type UpdateState = Found & { appVersion: string; checkedAt: number };

let found: Found = { state: 'idle' };
let checkedAt = 0;
let current: UpdateState = { state: 'idle', appVersion: '', checkedAt: 0 };
let updater: typeof import('electron-updater').autoUpdater | null = null;

function publish(next: Found): void {
  found = next;
  current = { ...next, appVersion: app.getVersion(), checkedAt };
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('dolphin:update', current);
  }
}

/** Set by CI when it signs the Mac build (package.json extraMetadata). */
function signedBuild(): boolean {
  try {
    return Boolean(JSON.parse(readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8')).dolphinSigned);
  } catch {
    return false;
  }
}

/** An AppImage, or a signed Mac app, replaces itself (releases.ts). */
function selfUpdating(): boolean {
  return canSelfUpdate({ platform: process.platform, packaged: app.isPackaged, appImage: Boolean(process.env.APPIMAGE), signed: signedBuild() });
}

/** A packaged Mac app without a Developer ID: its bundle, and why it cannot
 *  replace itself (null when it can). Not a Mac app of that kind: null. */
function unsignedMac(): { bundle: string; blocker: string | null } | null {
  if (process.platform !== 'darwin' || !app.isPackaged || signedBuild()) return null;
  const bundle = appBundleOf(process.execPath);
  return bundle ? { bundle, blocker: inPlaceBlocker(bundle) } : null;
}
/** Where macUpdate.ts downloads and unpacks; nothing in it outlives the next launch. */
const macUpdates = () => path.join(app.getPath('userData'), 'updates');

const channel = (): Channel => readSettings(app.getPath('userData')).updateChannel;

async function newestRelease(wanted: Channel): Promise<Release | undefined> {
  const feed = process.env.DOLPHIN_DESKTOP_UPDATE_FEED || RELEASES;
  const response = await net.fetch(feed, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Dolphin/${app.getVersion()}` } });
  if (!response.ok) throw new Error(`the release feed answered ${response.status}`);
  const body = (await response.json()) as Release | Release[];
  return pickRelease(Array.isArray(body) ? body : [body], wanted);
}

async function startUpdater(): Promise<NonNullable<typeof updater>> {
  if (updater) return updater;
  const { autoUpdater } = await import('electron-updater');
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;
  autoUpdater.on('download-progress', (progress) => {
    if (current.state === 'downloading' || current.state === 'checking' || current.state === 'idle') {
      publish({ state: 'downloading', version: version(), percent: Math.round(progress.percent), notesUrl: notesFor(version()) });
    }
  });
  autoUpdater.on('update-downloaded', (info) => {
    publish({ state: 'ready', version: info.version, action: 'restart', notesUrl: notesFor(info.version) });
    // Tests only: press "Restart to Update" as soon as it appears.
    if (process.env.DOLPHIN_DESKTOP_UPDATE_RESTART_AT_ONCE) setTimeout(() => void apply(), 2000);
  });
  autoUpdater.on('update-not-available', () => publish({ state: 'current' }));
  autoUpdater.on('error', (error) => fail(error, asked));
  updater = autoUpdater;
  return autoUpdater;
}

let pendingVersion = '';
let downloadToken: { cancel(): void } | null = null;
/** The Mac download in progress (macUpdate.ts), and the update it unpacked. */
let macDownload: AbortController | null = null;
let macStaged: { bundle: string; staged: string; dir: string } | null = null;
const version = () => pendingVersion;

let asked = false;
let before: Found = { state: 'idle' };

/** A failed check the user asked for says why; a quiet one leaves things as they were. */
function fail(error: unknown, manual: boolean): void {
  if (manual) publish({ state: 'error', message: error instanceof Error ? error.message : String(error) });
  else publish(before.state === 'checking' || before.state === 'error' ? { state: checkedAt ? 'current' : 'idle' } : before);
}

/** Look for a newer release. Returns what it found; windows hear it too.
 *  `manual` is a check the user asked for: only those report failures. */
export async function checkForUpdates(manual = false): Promise<UpdateState> {
  if (found.state === 'checking') { asked ||= manual; return current; }
  if (found.state === 'downloading' || found.state === 'ready') return current;
  asked = manual;
  before = found;
  publish({ state: 'checking' });
  try {
    const release = await newestRelease(channel());
    const latest = tagVersion(release?.tag_name);
    checkedAt = Date.now();
    if (!release || !latest || compareVersions(latest, app.getVersion()) <= 0) {
      publish({ state: 'current' });
      return current;
    }
    pendingVersion = latest;
    const notesUrl = release.html_url || notesFor(pendingVersion);
    if (selfUpdating()) {
      publish({ state: 'downloading', version: pendingVersion, percent: 0, notesUrl });
      const selfUpdater = await startUpdater();
      // A prerelease's update files are beta-linux.yml / beta-mac.yml. Setting a
      // channel also turns downgrades on, which Dolphin never offers.
      selfUpdater.channel = updateFilesChannel(pendingVersion);
      selfUpdater.allowPrerelease = pendingVersion.includes('-');
      selfUpdater.allowDowngrade = false;
      // That release's own files (latest-linux.yml beside the AppImage, the
      // release job's latest-mac.yml), so electron-updater needs no opinion
      // about how releases are tagged.
      selfUpdater.setFeedURL({ provider: 'generic', url: process.env.DOLPHIN_DESKTOP_UPDATE_FILES || `${DOWNLOADS}/desktop-v${pendingVersion}` });
      selfUpdater.autoInstallOnAppQuit = true; // a channel switch may have turned it off
      const result = await selfUpdater.checkForUpdates();
      downloadToken = result?.cancellationToken ?? null;
      return current;
    }
    const mac = unsignedMac();
    if (mac && !mac.blocker) {
      publish({ state: 'downloading', version: pendingVersion, percent: 0, notesUrl });
      void downloadForMac(mac.bundle, pendingVersion, notesUrl);
      return current;
    }
    const pkg = process.platform === 'darwin' ? 'dmg' : linuxPackage({ appImage: Boolean(process.env.APPIMAGE), hasDpkg: existsSync('/usr/bin/dpkg'), hasRpm: existsSync('/usr/bin/rpm') });
    const url = installerFor(release, process.platform, process.arch, pkg) ?? release.html_url ?? '';
    publish({ state: 'available', version: pendingVersion, action: 'download', url, notesUrl, ...(mac?.blocker ? { note: mac.blocker } : {}) });
  } catch (error) {
    fail(error, asked);
  }
  return current;
}

/** A Mac without a Developer ID: download this Mac's zip from the release,
 *  check it, unpack it, and offer Restart to Update (macUpdate.ts). */
async function downloadForMac(bundle: string, version: string, notesUrl: string): Promise<void> {
  macDownload?.abort();
  const controller = new AbortController();
  macDownload = controller;
  const mine = () => macDownload === controller;
  const dir = path.join(macUpdates(), version);
  const base = process.env.DOLPHIN_DESKTOP_UPDATE_FILES || `${DOWNLOADS}/desktop-v${version}`;
  const fetch = (url: string, init?: { signal?: AbortSignal }) => net.fetch(url, { ...init, headers: { 'User-Agent': `Dolphin/${app.getVersion()}` } });
  try {
    const feed = await fetch(`${base}/${updateFilesChannel(version)}-mac.yml`, { signal: controller.signal });
    if (!feed.ok) throw new Error(`the update feed answered ${feed.status}`);
    const file = macZipFor(parseMacFeed(await feed.text()), process.arch);
    if (!file) throw new Error(`the release has no update for this Mac (${process.arch})`);
    const zip = path.join(dir, path.basename(file.url));
    await downloadVerified({ ...file, url: `${base}/${file.url}` }, zip, {
      fetch, signal: controller.signal,
      onProgress: (percent) => { if (mine()) publish({ state: 'downloading', version, percent, notesUrl }); },
    });
    const staged = await unpackUpdate(zip, path.join(dir, 'app'), version);
    rmSync(zip, { force: true });
    if (!mine()) return;
    macStaged = { bundle, staged, dir };
    publish({ state: 'ready', version, action: 'restart', notesUrl });
    // Tests only: press "Restart to Update" as soon as it appears.
    if (process.env.DOLPHIN_DESKTOP_UPDATE_RESTART_AT_ONCE) setTimeout(() => void apply(), 2000);
  } catch (error) {
    if (!mine()) return; // abandoned: a channel switch, or a newer download
    rmSync(dir, { recursive: true, force: true });
    fail(error, asked);
  } finally {
    if (mine()) macDownload = null;
  }
}

/** Swap in the unpacked Mac update once Dolphin has quit; `relaunch` opens it again. */
function installMac(relaunch: boolean): boolean {
  const staged = macStaged;
  if (!staged) return false;
  macStaged = null;
  startSwap({ dir: staged.dir, pid: process.pid, current: staged.bundle, staged: staged.staged, relaunch });
  return true;
}

/** Quitting with an update unpacked installs it, as electron-updater does
 *  (main.ts calls this as Dolphin quits). */
export function installUpdateOnQuit(): void {
  installMac(false);
}

/** Waking up or coming back to the window: check, unless a check is recent. */
function checkIfStale(): void {
  if (Date.now() - checkedAt >= STALE_MS) void checkForUpdates();
}

/** The button: download the installer, or restart into the downloaded update. */
async function apply(): Promise<void> {
  if (current.state === 'available') await shell.openExternal(current.url);
  if (current.state === 'ready' && macStaged) {
    installMac(true);
    app.quit();
    return;
  }
  if (current.state === 'ready' && updater) updater.quitAndInstall(true, true); // silent install, then reopen Dolphin
}

/** Check for Updates… in the menu: the window's About panel opens and shows the
 *  check. With no window open, a dialog says what it found. */
export async function checkFromMenu(window?: BrowserWindow): Promise<void> {
  if (window && !window.isDestroyed()) {
    window.webContents.send('dolphin:update-open');
    void checkForUpdates(true);
    return;
  }
  const found = await checkForUpdates(true);
  const options = (message: string, detail?: string): Electron.MessageBoxOptions => ({ type: 'info', message, detail, buttons: ['OK'] });
  if (found.state === 'current') {
    await (window ? dialog.showMessageBox(window, options(`Dolphin ${app.getVersion()} is the latest version.`)) : dialog.showMessageBox(options(`Dolphin ${app.getVersion()} is the latest version.`)));
  } else if (found.state === 'error') {
    const box = options('Dolphin could not check for updates.', `${found.message}\nCheck your connection and try again.`);
    await (window ? dialog.showMessageBox(window, box) : dialog.showMessageBox(box));
  }
  // available / downloading / ready show in the window, with their button.
}

/** The version this app ran last time, so the first window after an update can
 *  say what is new. A first install has nothing to announce. */
let whatsNew: { version: string; notesUrl: string } | null = null;
let whatsNewWindow: number | null = null;
function noteVersion(): void {
  const file = path.join(app.getPath('userData'), 'last-version');
  let last = '';
  try { last = readFileSync(file, 'utf8').trim(); } catch { /* first run */ }
  const now = app.getVersion();
  if (last && last !== now) whatsNew = { version: now, notesUrl: notesFor(now) };
  try { writeFileSync(file, now); } catch { /* a read-only profile only loses the announcement */ }
}

/** Going back to stable never installs a beta: abort its download, unstage it
 *  (nothing installs on quit) and clear the offer. Stable then checks as usual,
 *  and never downgrades. */
async function leavePrerelease(now: Channel): Promise<void> {
  if (now !== 'stable' || !pendingVersion.includes('-')) return;
  if (found.state !== 'downloading' && found.state !== 'ready') return;
  macDownload?.abort();
  macDownload = null;
  if (macStaged) rmSync(macStaged.dir, { recursive: true, force: true });
  macStaged = null;
  if (updater) {
    try {
      await dropStagedUpdate(updater as unknown as StagedUpdater, downloadToken ?? undefined);
    } catch (error) {
      console.error('Dolphin could not clear the beta update:', error);
    }
  }
  downloadToken = null;
  pendingVersion = '';
  publish({ state: 'idle' });
}

export function startUpdateChecks(): void {
  publish(found);
  noteVersion();
  // An update unpacked last time was installed on quit, or abandoned.
  if (process.platform === 'darwin') rmSync(macUpdates(), { recursive: true, force: true });
  ipcMain.on('dolphin:update-state', (event) => { event.returnValue = current; });
  ipcMain.handle('dolphin:update-apply', () => apply());
  ipcMain.handle('dolphin:update-check', () => checkForUpdates(true));
  // One window says what is new: the first to ask (a reload of it asks again).
  ipcMain.on('dolphin:whats-new', (event) => {
    if (whatsNew && whatsNewWindow === null) whatsNewWindow = event.sender.id;
    event.returnValue = event.sender.id === whatsNewWindow ? whatsNew : null;
  });
  ipcMain.on('dolphin:whats-new-seen', () => { whatsNew = null; });
  if (!app.isPackaged && !process.env.DOLPHIN_DESKTOP_UPDATE_FEED) return; // a development build has nothing to update to
  setTimeout(() => void checkForUpdates(), Number(process.env.DOLPHIN_DESKTOP_UPDATE_DELAY_MS) || FIRST_CHECK_MS);
  setInterval(() => void checkForUpdates(), EVERY_MS);
  // A new channel changes which releases count: look again now.
  onSettingsChange((next, previous) => {
    if (next.updateChannel === previous.updateChannel) return;
    void leavePrerelease(next.updateChannel).then(() => checkForUpdates());
  });
  // Give the network a moment after waking before asking.
  powerMonitor.on('resume', () => setTimeout(checkIfStale, 5_000));
  app.on('browser-window-focus', checkIfStale);
}
