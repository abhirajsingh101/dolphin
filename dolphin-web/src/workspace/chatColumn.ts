/* The chat column beside the terminal (design contract §4, "Glass layout").
   380px by default; 280px at the least. A terminal under 640px drops below
   80 columns at the default 13px font, so when the chat would leave less than
   that, it folds when windows open. */

export const CHAT_DEFAULT_WIDTH = 380;
export const CHAT_MIN_WIDTH = 280;
export const CHAT_MAX_REMEMBERED_WIDTH = 900;
export const TERMINAL_MIN_WIDTH = 640;
export const SEPARATOR_WIDTH = 6;

export function chatFits(centreWidth: number, chatWidth: number): boolean {
  return centreWidth - chatWidth - SEPARATOR_WIDTH >= TERMINAL_MIN_WIDTH;
}

export function clampChatWidth(width: unknown): number {
  if (typeof width !== 'number' || !Number.isFinite(width)) return CHAT_DEFAULT_WIDTH;
  return Math.round(Math.min(CHAT_MAX_REMEMBERED_WIDTH, Math.max(CHAT_MIN_WIDTH, width)));
}

export function foldShortcut(mac: boolean): string {
  return mac ? '⌘/' : 'Ctrl+/';
}
