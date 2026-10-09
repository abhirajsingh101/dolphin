/* Keeping Dolphin up to date.
 *
 * Releases are GitHub releases tagged desktop-vX.Y.Z. Dolphin checks for a newer
 * one shortly after it starts and every six hours, and from Dolphin > Check for
 * Updates…. What happens next depends on how it was installed:
 *
 * - AppImage: electron-updater downloads the update in the background; the
 *   user restarts when it suits them ("Restart to Update").
 * - macOS and .deb: the app offers the matching installer ("Download").
 *   macOS refuses to install updates into an unsigned app, and a .deb belongs
 *   to the system's package manager, so neither can update itself yet.
 *
 * Windows show the state as a line above the chat (dolphin:update). The helper
 * follows on its own: a newer app brings a newer helper, which replaces the old
 * one when it starts (app/helper.py), on this computer and on SSH machines.
 */

import { app, BrowserWindow, dialog, ipcMain, net, shell } from 'electron';
import { installerFor, isNewer, Release, releaseVersion } from './releases';

export const RELEASES = 'https://api.github.com/repos/abhirajsingh101/dolphin/releases/latest';
const DOWNLOADS = 'https://github.com/abhirajsingh101/dolphin/releases/download';
const FIRST_CHECK_MS = 15_000;
const EVERY_MS = 6 * 60 * 60 * 1000;

export type UpdateState =
  | { state: 'idle' | 'checking' | 'current' }
  | { state: 'available'; version: string; action: 'download'; url: string }
  | { state: 'downloading'; version: string; percent: number }
  | { state: 'ready'; version: string; action: 'restart' }
  | { state: 'error'; message: string };

let current: UpdateState = { state: 'idle' };
let updater: typeof import('electron-updater').autoUpdater | null = null;

function publish(next: UpdateState): void {
  current = next;
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
      publish({ state: 'downloading', version: version(), percent: Math.round(progress.percent) });
    }
  });
  autoUpdater.on('update-downloaded', (info) => {
    publish({ state: 'ready', version: info.version, action: 'restart' });
    // Tests only: press "Restart to Update" as soon as it appears.
    if (process.env.DOLPHIN_DESKTOP_UPDATE_RESTART_AT_ONCE) setTimeout(() => void apply(), 2000);
  });
  autoUpdater.on('update-not-available', () => publish({ state: 'current' }));
  autoUpdater.on('error', (error) => publish({ state: 'error', message: error.message }));
  updater = autoUpdater;
  return autoUpdater;
}

let pendingVersion = '';
const version = () => pendingVersion;

/** Look for a newer release. Returns what it found; windows hear it too. */
export async function checkForUpdates(): Promise<UpdateState> {
  if (current.state === 'downloading' || current.state === 'ready') return current;
  publish({ state: 'checking' });
  try {
    const release = await latestRelease();
    const found = releaseVersion(release.tag_name);
    if (!found || release.draft || release.prerelease || !isNewer(found, app.getVersion())) {
      publish({ state: 'current' });
      return current;
    }
    pendingVersion = found.join('.');
    if (selfUpdating()) {
      publish({ state: 'downloading', version: pendingVersion, percent: 0 });
      const appImageUpdater = await startUpdater();
      // That release's own files (latest-linux.yml beside the AppImage), so
      // electron-updater needs no opinion about how releases are tagged.
      appImageUpdater.setFeedURL({ provider: 'generic', url: process.env.DOLPHIN_DESKTOP_UPDATE_FILES || `${DOWNLOADS}/desktop-v${pendingVersion}` });
      await appImageUpdater.checkForUpdates();
      return current;
    }
    const url = installerFor(release, process.platform, process.arch, false) ?? release.html_url ?? '';
    publish({ state: 'available', version: pendingVersion, action: 'download', url });
  } catch (error) {
    publish({ state: 'error', message: error instanceof Error ? error.message : String(error) });
  }
  return current;
}

/** The button: download the installer, or restart into the downloaded update. */
async function apply(): Promise<void> {
  if (current.state === 'available') await shell.openExternal(current.url);
  if (current.state === 'ready' && updater) updater.quitAndInstall(true, true); // silent install, then reopen Dolphin
}

/** Dolphin > Check for Updates…: says what it found, even when nothing is new. */
export async function checkFromMenu(window?: BrowserWindow): Promise<void> {
  const found = await checkForUpdates();
  const options = (message: string, detail?: string): Electron.MessageBoxOptions => ({ type: 'info', message, detail, buttons: ['OK'] });
  if (found.state === 'current') {
    await (window ? dialog.showMessageBox(window, options(`Dolphin ${app.getVersion()} is the latest version.`)) : dialog.showMessageBox(options(`Dolphin ${app.getVersion()} is the latest version.`)));
  } else if (found.state === 'error') {
    const box = options('Dolphin could not check for updates.', `${found.message}\nCheck your connection and try again.`);
    await (window ? dialog.showMessageBox(window, box) : dialog.showMessageBox(box));
  }
  // available / downloading / ready show in the window, with their button.
}

export function startUpdateChecks(): void {
  ipcMain.on('dolphin:update-state', (event) => { event.returnValue = current; });
  ipcMain.handle('dolphin:update-apply', () => apply());
  if (!app.isPackaged && !process.env.DOLPHIN_DESKTOP_UPDATE_FEED) return; // a development build has nothing to update to
  setTimeout(() => void checkForUpdates(), Number(process.env.DOLPHIN_DESKTOP_UPDATE_DELAY_MS) || FIRST_CHECK_MS);
  setInterval(() => void checkForUpdates(), EVERY_MS);
}
