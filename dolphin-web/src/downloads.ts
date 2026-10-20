/* The downloads list Dolphin Desktop keeps (dolphin-desktop/src/main.ts):
   what each row and the top-bar button say. */

export type Download = {
  id: string;
  name: string;
  file: string;
  machine?: string;
  received: number;
  /** 0 when the machine did not say. */
  total: number;
  state: 'progressing' | 'completed' | 'cancelled' | 'failed';
  error?: string;
  started: number;
};

/** Sizes as Finder shows them: decimal units, one decimal under 10. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1000) return `${Math.max(0, Math.round(bytes || 0))} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit += 1; }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** The second line of a row. */
export function downloadDetail(download: Download): string {
  const from = download.machine ? ` · ${download.machine}` : '';
  switch (download.state) {
    case 'progressing':
      return `${download.total > 0 ? `${formatBytes(download.received)} of ${formatBytes(download.total)}` : formatBytes(download.received)}${from}`;
    case 'completed':
      return `${formatBytes(download.total || download.received)}${from} · Saved to Downloads`;
    case 'cancelled':
      return `Cancelled${from}`;
    default:
      return download.error ?? 'Stopped before it finished.';
  }
}

/** 0–1 of one download, or null when its size is unknown. */
export function fractionOf(download: Download): number | null {
  if (download.state === 'completed') return 1;
  return download.total > 0 ? Math.min(1, download.received / download.total) : null;
}

/** What is downloading now: how many, and how far along together (null when
    a size is unknown, so the button shows a spinner instead of a ring). */
export function overallProgress(downloads: Download[]): { active: number; fraction: number | null } {
  const active = downloads.filter((download) => download.state === 'progressing');
  if (active.some((download) => download.total <= 0)) return { active: active.length, fraction: null };
  const total = active.reduce((sum, download) => sum + download.total, 0);
  const received = active.reduce((sum, download) => sum + download.received, 0);
  return { active: active.length, fraction: total > 0 ? Math.min(1, received / total) : null };
}

export function downloadsLabel(downloads: Download[]): string {
  const { active } = overallProgress(downloads);
  return active ? `Downloads, ${active} in progress` : 'Downloads';
}
