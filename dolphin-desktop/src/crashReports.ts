/* Crash reports stay on this computer. With the crashReports setting at
 * 'local' (the default) Electron's crash reporter writes minidumps into
 * <userData>/Crash Reports and uploads nothing: no submitURL, uploadToServer
 * false. 'off' does not start it. Help → Show Crash Reports opens the folder,
 * so a user can attach a report to an issue if they choose. The setting takes
 * effect at the next launch: the reporter cannot be stopped once started.
 * Type-only Electron import, so tests can load it. */

import type { CrashReporterStartOptions } from 'electron';

export const CRASH_DIR = 'Crash Reports';

export function crashReporterOptions(setting: 'off' | 'local'): CrashReporterStartOptions | null {
  return setting === 'off' ? null : { uploadToServer: false, compress: true };
}
