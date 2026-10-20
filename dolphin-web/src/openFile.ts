import { machineBridge } from './machines';
import { currentPlatform } from './shortcutLabel';

type FileBridge = { openFile?: (machine: string, file: string) => Promise<{ shown?: string; saved?: string; error?: string; download?: string }> };

const isLocal = (machine?: string) => !machine || machine === 'local';

/** What this OS calls the app that shows a file in its folder. */
export function fileManagerName(platform: string = currentPlatform()): string {
  if (/^(darwin|mac)/i.test(platform)) return 'Finder';
  if (/^win/i.test(platform)) return 'File Explorer';
  return 'the file manager';
}

/** The tooltip on a file path link: what a click will do. */
export function fileLinkTitle(path: string, machine?: string, platform?: string): string {
  return isLocal(machine) ? `Show ${path} in ${fileManagerName(platform)}` : `Download ${path} to this computer's Downloads`;
}

/** A file path clicked in a terminal. In Dolphin Desktop the main process
    shows it in its folder when the machine is this computer, and saves it to
    this computer's Downloads when the machine is reached over SSH; the
    downloads list in the top bar shows its progress. `say` hears an error
    that is not on that list. False without that bridge (the web app, or an
    older Desktop): the caller downloads through the browser as before. */
export function openTerminalFile(
  path: string,
  machine: string | undefined,
  say: (text: string, ms: number) => void,
  bridge: FileBridge | null | undefined = machineBridge(),
): boolean {
  if (!bridge?.openFile) return false;
  bridge.openFile(machine ?? 'local', path).then((result) => {
    if (result.error && !result.download) say(result.error, 5000);
  }, (reason) => say(reason instanceof Error ? reason.message : String(reason), 5000));
  return true;
}
