/* Reading Dolphin's GitHub releases: which version a release is, whether it is
 * newer than this app, and which installer fits this machine. No Electron here,
 * so it is testable on its own (test/releases.test.mjs). */

export type Release = { tag_name?: string; html_url?: string; draft?: boolean; prerelease?: boolean; assets?: { name: string; browser_download_url: string }[] };

/** "desktop-v0.1.2" → [0, 1, 2]; anything else → null. */
export function releaseVersion(tag: string | undefined): number[] | null {
  const match = /^desktop-v(\d+)\.(\d+)\.(\d+)$/.exec(tag ?? '');
  return match ? match.slice(1).map(Number) : null;
}

export function isNewer(candidate: number[], current: string): boolean {
  const mine = current.split('.').map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < 3; index += 1) {
    if ((candidate[index] ?? 0) !== (mine[index] ?? 0)) return (candidate[index] ?? 0) > (mine[index] ?? 0);
  }
  return false;
}

/** The installer a user of this platform should download. */
export function installerFor(release: Release, platform: string, arch: string, appImage: boolean): string | undefined {
  const pick = (test: (name: string) => boolean) => release.assets?.find((asset) => test(asset.name))?.browser_download_url;
  if (platform === 'darwin') {
    return arch === 'arm64' ? pick((name) => name.endsWith('-arm64.dmg')) : pick((name) => name.endsWith('.dmg') && !name.includes('-arm64'));
  }
  if (platform === 'linux') {
    return appImage ? pick((name) => name.endsWith('.AppImage')) : pick((name) => name.endsWith('.deb'));
  }
  return undefined;
}
