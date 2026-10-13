/* The parts of Dolphin Desktop's preload bridge (dolphin-desktop/src/preload.ts)
   that the workspace uses for settings and keyboard commands. Everything here
   is absent in the web app, where `window.dolphinDesktop` does not exist. */

import { isMacPlatform } from '../shortcutLabel';

/** The one helper lives in shortcutLabel.ts; it reads the preload's platform. */
export { isMacPlatform };

export type DesktopSettings = {
  updateChannel: 'stable' | 'beta';
  memory: boolean;
  crashReports: 'off' | 'local';
  agentForwarding: Record<string, boolean>;
};
export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = { updateChannel: 'stable', memory: false, crashReports: 'local', agentForwarding: {} };

type Bridge = {
  platform?: string;
  settings?: { get(): DesktopSettings; set(patch: Partial<DesktopSettings>): Promise<DesktopSettings> };
  onCommand?: (listener: (id: string) => void) => (() => void) | void;
  openLogs?: () => void;
};

export const bridge = (): Bridge | undefined =>
  typeof window === 'undefined' ? undefined : (window as { dolphinDesktop?: Bridge }).dolphinDesktop;

export function desktopSettingsBridge() {
  return bridge()?.settings;
}

/* Keyboard commands (spec: "Keyboard"; dolphin-desktop/src/keymap.ts). */
export const COMMAND_IDS = [
  'palette',
  'session-1', 'session-2', 'session-3', 'session-4', 'session-5', 'session-6', 'session-7', 'session-8', 'session-9',
  'new-session', 'prev-tab', 'next-tab', 'settings', 'find', 'zoom-in', 'zoom-out', 'zoom-reset', 'close-view',
] as const;
export type CommandId = (typeof COMMAND_IDS)[number];
const KNOWN = new Set<string>(COMMAND_IDS);

/** Listen for menu commands. A no-op outside Dolphin Desktop. */
export function onDesktopCommand(listener: (id: CommandId) => void): () => void {
  const stop = bridge()?.onCommand?.((id) => { if (KNOWN.has(id)) listener(id as CommandId); });
  return typeof stop === 'function' ? stop : () => undefined;
}
