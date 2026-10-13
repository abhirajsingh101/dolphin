/* App-level keyboard commands (spec: "Keyboard"). They are menu items, so they
 * work while a terminal has the keyboard. On macOS the menu takes the key before
 * the page sees it; on Linux and Windows the page sees keys first and the menu
 * handles the ones it leaves unhandled, so the page must not preventDefault
 * these combinations. Either way the page gets only the command id
 * (dolphin:command).
 *
 * Linux and Windows differ from the spec table in one place: Find is
 * Ctrl+Shift+F, as in GNOME Terminal and Windows Terminal, because Ctrl+F is
 * readline's forward-char and vim's page-down in the terminal. Close Session
 * View (Cmd+W) is macOS only, as the spec says; Ctrl+W is delete-word. */

import type { MenuItemConstructorOptions } from 'electron';

export const COMMAND_IDS = [
  'palette',
  'session-1', 'session-2', 'session-3', 'session-4', 'session-5', 'session-6', 'session-7', 'session-8', 'session-9',
  'new-session', 'prev-tab', 'next-tab', 'settings', 'find', 'zoom-in', 'zoom-out', 'zoom-reset', 'close-view',
] as const;
export type CommandId = (typeof COMMAND_IDS)[number];
export type KeyBinding = { id: CommandId; label: string; accelerator: string };

export function keyBindings(platform: string): KeyBinding[] {
  const mac = platform === 'darwin';
  return [
    { id: 'palette', label: 'Command Palette…', accelerator: 'CmdOrCtrl+Shift+K' },
    ...Array.from({ length: 9 }, (_, index): KeyBinding => ({ id: `session-${index + 1}` as CommandId, label: `Pinned Session ${index + 1}`, accelerator: `CmdOrCtrl+${index + 1}` })),
    { id: 'new-session', label: 'New Session…', accelerator: 'CmdOrCtrl+Shift+T' },
    { id: 'prev-tab', label: 'Previous Tab', accelerator: 'CmdOrCtrl+Shift+[' },
    { id: 'next-tab', label: 'Next Tab', accelerator: 'CmdOrCtrl+Shift+]' },
    { id: 'settings', label: 'Settings…', accelerator: 'CmdOrCtrl+,' },
    { id: 'find', label: 'Find in Terminal…', accelerator: mac ? 'Cmd+F' : 'Ctrl+Shift+F' },
    { id: 'zoom-in', label: 'Zoom In', accelerator: 'CmdOrCtrl+=' },
    { id: 'zoom-out', label: 'Zoom Out', accelerator: 'CmdOrCtrl+-' },
    { id: 'zoom-reset', label: 'Actual Size', accelerator: 'CmdOrCtrl+0' },
    ...(mac ? [{ id: 'close-view' as const, label: 'Close Session View', accelerator: 'Cmd+W' }] : []),
  ];
}

export function commandItem(bindings: KeyBinding[], id: CommandId, send: (id: CommandId) => void): MenuItemConstructorOptions {
  const binding = bindings.find((item) => item.id === id);
  if (!binding) throw new Error(`No key binding for ${id}`);
  return { id, label: binding.label, accelerator: binding.accelerator, click: () => send(id) };
}
