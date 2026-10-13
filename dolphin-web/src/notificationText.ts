import type { AppNotification } from './types';

/* How a finished turn is named in pop-ups, the bell and system notifications.
   Summaries arrive as plain text (the backend strips Markdown). */

const AGENT = { claude: 'Claude Code', codex: 'Codex' } as const;

export function notificationTitle(item: Pick<AppNotification, 'session_name' | 'project_name'>): string {
  return `${item.session_name} · ${item.project_name ?? 'No project'}`;
}

/** A system pop-up's text. Another computer's name joins the title; this one's never does. */
export function systemNotificationText(
  item: Pick<AppNotification, 'session_name' | 'project_name' | 'summary' | 'provider'>,
  machineLabel?: string,
): { title: string; body: string } {
  const title = notificationTitle(item);
  return { title: machineLabel ? `${title} · ${machineLabel}` : title, body: item.summary.trim() || `${AGENT[item.provider]} finished its turn.` };
}

/** The web app raises its own system pop-up while the window is unfocused or
    hidden. Dolphin Desktop's main process raises them instead. */
export function wantsBrowserNotification({ hidden, focused, granted, enabled, desktop }: {
  hidden: boolean; focused: boolean; granted: boolean; enabled: boolean; desktop: boolean;
}): boolean {
  return !desktop && enabled && granted && (hidden || !focused);
}
