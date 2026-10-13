/* Reading Dolphin's GitHub releases: which version a release is, which one an
 * update channel may offer, and which installer fits this machine. No Electron
 * here, so it is testable on its own (test/releases.test.mjs).
 *
 * Installers are named Dolphin-<version>-<os>-<arch>.<ext> since 0.2.0
 * (package.json build.artifactName), with electron-builder's arch words:
 * x86_64 (AppImage, rpm), amd64 (deb), aarch64 (rpm), arm64, x64. Before 0.2.0
 * an installer without an architecture in its name was the x64 one. */

export type Release = { tag_name?: string; html_url?: string; draft?: boolean; prerelease?: boolean; assets?: { name: string; browser_download_url: string }[] };
export type Channel = 'stable' | 'beta';
export type Package = 'appimage' | 'deb' | 'rpm' | 'dmg';

/** "desktop-v0.1.2" → [0, 1, 2]; anything else, prereleases included → null. */
export function releaseVersion(tag: string | undefined): number[] | null {
  const match = /^desktop-v(\d+)\.(\d+)\.(\d+)$/.exec(tag ?? '');
  return match ? match.slice(1).map(Number) : null;
}

/** "desktop-v0.3.0-beta.1" → "0.3.0-beta.1"; anything else → null. */
export function tagVersion(tag: string | undefined): string | null {
  const match = /^desktop-v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(tag ?? '');
  return match ? match[1] : null;
}

function parse(version: string): { core: number[]; pre: (number | string)[] } {
  const [core, ...rest] = version.split('-');
  const pre = rest.join('-');
  return {
    core: core.split('.').map((part) => Number.parseInt(part, 10) || 0),
    pre: pre ? pre.split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part)) : [],
  };
}

/** Semver order: 0.3.0-beta.2 < 0.3.0-beta.10 < 0.3.0-rc.1 < 0.3.0 < 0.3.1. */
export function compareVersions(a: string, b: string): number {
  const x = parse(a);
  const y = parse(b);
  for (let index = 0; index < 3; index += 1) {
    const difference = (x.core[index] ?? 0) - (y.core[index] ?? 0);
    if (difference) return Math.sign(difference);
  }
  if (x.pre.length === 0 || y.pre.length === 0) return (x.pre.length === 0 ? 1 : 0) - (y.pre.length === 0 ? 1 : 0);
  for (let index = 0; index < Math.max(x.pre.length, y.pre.length); index += 1) {
    const p = x.pre[index];
    const q = y.pre[index];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    if (typeof p === 'number' && typeof q === 'number') return Math.sign(p - q);
    if (typeof p === 'number') return -1;
    if (typeof q === 'number') return 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

export function isNewer(candidate: number[], current: string): boolean {
  return compareVersions(candidate.join('.'), current) > 0;
}

/** The newest release a channel may offer: stable never sees a prerelease
 *  (by flag or by tag); beta sees both. Drafts and foreign tags are skipped. */
export function pickRelease(releases: Release[], channel: Channel): Release | undefined {
  let best: { release: Release; version: string } | undefined;
  for (const release of releases) {
    const version = tagVersion(release.tag_name);
    if (!version || release.draft) continue;
    if ((version.includes('-') || release.prerelease) && channel !== 'beta') continue;
    if (!best || compareVersions(version, best.version) > 0) best = { release, version };
  }
  return best?.release;
}

const ARCH_WORDS: Record<string, string[]> = { x64: ['x64', 'x86_64', 'amd64'], arm64: ['arm64', 'aarch64'] };
const ALL_WORDS = Object.values(ARCH_WORDS).flat();
const EXTENSION: Record<Package, string> = { appimage: '.AppImage', deb: '.deb', rpm: '.rpm', dmg: '.dmg' };

/** The installer a user of this machine should download. */
export function installerFor(release: Release, platform: string, arch: string, pkg: Package): string | undefined {
  if (platform !== 'darwin' && platform !== 'linux') return undefined;
  if ((platform === 'darwin') !== (pkg === 'dmg')) return undefined;
  const extension = EXTENSION[pkg];
  const candidates = (release.assets ?? []).filter((asset) => asset.name.endsWith(extension));
  const archOf = (name: string) => {
    const stem = name.slice(0, -extension.length);
    return ALL_WORDS.find((word) => new RegExp(`[-_.]${word}$`).test(stem));
  };
  const mine = ARCH_WORDS[arch] ?? [];
  const exact = candidates.find((asset) => mine.includes(archOf(asset.name) ?? ''));
  const unnamed = arch === 'x64' ? candidates.find((asset) => archOf(asset.name) === undefined) : undefined;
  return (exact ?? unnamed)?.browser_download_url;
}

/** An AppImage replaces itself; a Mac app can once it is signed (macOS refuses
 *  to install updates into an unsigned app); a .deb or .rpm belongs to the
 *  system's package manager. */
export function canSelfUpdate(o: { platform: string; packaged: boolean; appImage: boolean; signed: boolean }): boolean {
  if (!o.packaged) return false;
  if (o.platform === 'linux') return o.appImage;
  if (o.platform === 'darwin') return o.signed;
  return false;
}

/** How Dolphin was installed on Linux, as far as an installer choice goes. */
export function linuxPackage(o: { appImage: boolean; hasDpkg: boolean; hasRpm: boolean }): Package {
  if (o.appImage) return 'appimage';
  return o.hasRpm && !o.hasDpkg ? 'rpm' : 'deb';
}

/** electron-builder names a release's update files after its version's
 *  prerelease word: latest-linux.yml for 0.2.0, beta-linux.yml for 0.2.1-beta.1. */
export function updateFilesChannel(version: string): string {
  const pre = version.split('-').slice(1).join('-');
  return pre ? pre.split('.')[0] : 'latest';
}

/** What of electron-updater's the channel switch touches. */
export type StagedUpdater = { autoInstallOnAppQuit: boolean; downloadedUpdateHelper?: { clear(): Promise<void> } | null };

/** Abandon a prerelease that is downloading or staged: stop the download, stop
 *  it installing on quit, and delete electron-updater's own cache of it. */
export async function dropStagedUpdate(updater: StagedUpdater, token?: { cancel(): void }): Promise<void> {
  token?.cancel();
  updater.autoInstallOnAppQuit = false;
  await updater.downloadedUpdateHelper?.clear();
}
