/* Keeping Dolphin up to date.
 *
 * Releases are GitHub releases tagged desktop-vX.Y.Z. Dolphin checks quietly:
 * ten seconds after it starts, every hour, and when the computer wakes or a
 * window comes back to the front after half an hour without a check. A check
 * on demand comes from the About panel (the Dolphin logo, or ⌘K) and from
 * Check for Updates… in the menu. What happens next depends on how it was
 * installed:
 *
 * - AppImage: electron-updater downloads the update in the background; the
 *   user restarts when it suits them ("Restart to Update").
 * - macOS and .deb: the app offers the matching installer ("Download").
 *   macOS refuses to install updates into an unsigned app, and a .deb belongs
 *   to the system's package manager, so neither can update itself yet.
 *
 * Windows hear every change (dolphin:update) and show it as a pill in the
 * header only when there is something to do, never as a dialog. A quiet check
 * that fails (offline, rate limited) shows nothing; one the user asked for
 * says why. After an update, the first window says what is new, once. The helper
 * follows on its own: a newer app brings a newer helper, which replaces the old
 * one when it starts (app/helper.py), on this computer and on SSH machines.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, net, powerMonitor, shell } from 'electron';
import { installerFor, isNewer, Release, releaseVersion } from './releases';

export const RELEASES = 'https://api.github.com/repos/abhirajsingh101/dolphin/releases/latest';
const DOWNLOADS = 'https://github.com/abhirajsingh101/dolphin/releases/download';
const FIRST_CHECK_MS = 10_000;
const EVERY_MS = 60 * 60 * 1000;
const STALE_MS = 30 * 60 * 1000;
const notesFor = (version: string) => `https://github.com/abhirajsingh101/dolphin/releases/tag/desktop-v${version}`;

type Found =
  | { state: 'idle' | 'checking' | 'current' }
  | { state: 'available'; version: string; action: 'download'; url: string; notesUrl: string }
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

/** An AppImage can replace itself; nothing else Dolphin ships can yet. */
function selfUpdating(): boolean {
  return process.platform === 'linux' && Boolean(process.env.APPIMAGE) && app.isPackaged;
}

async function latestRelease(): Promise<Release> {
  const feed = process.env.DOLPHIN_DESKTOP_UPDATE_FEED || RELEASES;
  const response = await net.fetch(feed, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Dolphin/${app.getVersion()}` } });
  if (!response.ok) throw new Error(`the release feed answered ${response.status}`);
  return (await response.json()) as Release;
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
    const release = await latestRelease();
    const latest = releaseVersion(release.tag_name);
    checkedAt = Date.now();
    if (!latest || release.draft || release.prerelease || !isNewer(latest, app.getVersion())) {
      publish({ state: 'current' });
      return current;
    }
    pendingVersion = latest.join('.');
    const notesUrl = release.html_url || notesFor(pendingVersion);
    if (selfUpdating()) {
      publish({ state: 'downloading', version: pendingVersion, percent: 0, notesUrl });
      const appImageUpdater = await startUpdater();
      // That release's own files (latest-linux.yml beside the AppImage), so
      // electron-updater needs no opinion about how releases are tagged.
      appImageUpdater.setFeedURL({ provider: 'generic', url: process.env.DOLPHIN_DESKTOP_UPDATE_FILES || `${DOWNLOADS}/desktop-v${pendingVersion}` });
      await appImageUpdater.checkForUpdates();
      return current;
    }
    const url = installerFor(release, process.platform, process.arch, false) ?? release.html_url ?? '';
    publish({ state: 'available', version: pendingVersion, action: 'download', url, notesUrl });
  } catch (error) {
    fail(error, asked);
  }
  return current;
}

/** Waking up or coming back to the window: check, unless a check is recent. */
function checkIfStale(): void {
  if (Date.now() - checkedAt >= STALE_MS) void checkForUpdates();
}

/** The button: download the installer, or restart into the downloaded update. */
async function apply(): Promise<void> {
  if (current.state === 'available') await shell.openExternal(current.url);
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
function noteVersion(): void {
  const file = path.join(app.getPath('userData'), 'last-version');
  let last = '';
  try { last = readFileSync(file, 'utf8').trim(); } catch { /* first run */ }
  const now = app.getVersion();
  if (last && last !== now) whatsNew = { version: now, notesUrl: notesFor(now) };
  try { writeFileSync(file, now); } catch { /* a read-only profile only loses the announcement */ }
}

export function startUpdateChecks(): void {
  publish(found);
  noteVersion();
  ipcMain.on('dolphin:update-state', (event) => { event.returnValue = current; });
  ipcMain.handle('dolphin:update-apply', () => apply());
  ipcMain.handle('dolphin:update-check', () => checkForUpdates(true));
  ipcMain.on('dolphin:whats-new', (event) => { event.returnValue = whatsNew; });
  ipcMain.on('dolphin:whats-new-seen', () => { whatsNew = null; });
  if (!app.isPackaged && !process.env.DOLPHIN_DESKTOP_UPDATE_FEED) return; // a development build has nothing to update to
  setTimeout(() => void checkForUpdates(), Number(process.env.DOLPHIN_DESKTOP_UPDATE_DELAY_MS) || FIRST_CHECK_MS);
  setInterval(() => void checkForUpdates(), EVERY_MS);
  // Give the network a moment after waking before asking.
  powerMonitor.on('resume', () => setTimeout(checkIfStale, 5_000));
  app.on('browser-window-focus', checkIfStale);
}
