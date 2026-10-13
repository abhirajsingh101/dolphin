/** The platform: Dolphin Desktop says it (process.platform); a browser has navigator.platform. */
export function currentPlatform(): string {
  if (typeof window === 'undefined') return '';
  return (window as { dolphinDesktop?: { platform?: string } }).dolphinDesktop?.platform
    ?? (typeof navigator === 'undefined' ? '' : navigator.platform ?? '');
}

/** The one place that decides "is this macOS" (darwin from the preload, MacIntel etc. from a browser). */
export const isMacPlatform = (platform: string | undefined = currentPlatform()) => /^(darwin|mac)/i.test(platform ?? '');

/** "⌘ K" on macOS, "Ctrl K" elsewhere. */
export function shortcutLabel(key: string, platform: string = currentPlatform()): string {
  return `${isMacPlatform(platform) ? '⌘' : 'Ctrl'} ${key}`;
}
