import { machineBridge } from './machines';

type LinkBridge = { openUrl?: (machine: string, url: string) => Promise<{ url?: string; error?: string }> };

/** Open a web link from a terminal or a panel in this computer's browser. In
    Dolphin Desktop the main process decides how: on a machine reached over
    SSH a loopback link (localhost:3000) is forwarded and rewritten to the
    forwarded port (dolphin-desktop/src/forwards.ts); any other link opens as
    it is. Resolves to an error to show, or null. */
export async function openLink(
  url: string,
  machine?: string,
  bridge: LinkBridge | null | undefined = machineBridge(),
): Promise<string | null> {
  let web = false;
  try {
    const parsed = new URL(url);
    web = (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname !== '';
  } catch { /* not a URL */ }
  if (!web) return 'Only web links open from here.';
  if (bridge) {
    // A bridge without openUrl is an older Dolphin Desktop: fail closed rather
    // than open a machine's link in a tab that cannot reach it.
    if (!bridge.openUrl) return 'This version of Dolphin Desktop cannot open links from here.';
    try {
      const result = await bridge.openUrl(machine ?? 'local', url);
      return result.error ?? null;
    } catch (reason) {
      return reason instanceof Error ? reason.message : String(reason);
    }
  }
  window.open(url, '_blank', 'noopener,noreferrer');
  return null;
}
