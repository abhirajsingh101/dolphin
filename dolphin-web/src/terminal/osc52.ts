import type { Terminal } from '@xterm/xterm';

/* OSC 52: a program (or tmux, for its own copy mode) asks the terminal to set
   the clipboard. Writes are honoured and announced; reads ("?") are refused
   and never answered, so output cannot exfiltrate the clipboard. */

/** About 768 KiB of text. Larger writes are ignored. */
export const OSC52_MAX_BASE64 = 1_048_576;

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export function parseOsc52(data: string): { kind: 'write'; text: string } | { kind: 'ignore' } {
  const split = data.indexOf(';');
  if (split < 0) return { kind: 'ignore' };
  const payload = data.slice(split + 1);
  if (payload === '' || payload === '?' || payload.length > OSC52_MAX_BASE64 || !BASE64.test(payload)) {
    return { kind: 'ignore' };
  }
  try {
    const bytes = Uint8Array.from(atob(payload), (char) => char.charCodeAt(0));
    return { kind: 'write', text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch {
    return { kind: 'ignore' };
  }
}

export function attachOsc52Clipboard(
  terminal: Terminal,
  deps: { writeText(text: string): Promise<void>; onResult(ok: boolean): void },
): () => void {
  const handler = terminal.parser.registerOscHandler(52, (data) => {
    const request = parseOsc52(data);
    if (request.kind === 'write') {
      const report = (ok: boolean) => {
        try { deps.onResult(ok); } catch { /* a failing notice must not escape */ }
      };
      Promise.resolve().then(() => deps.writeText(request.text)).then(() => report(true), () => report(false));
    }
    return true;
  });
  return () => handler.dispose();
}

/* No execCommand fallback: it needs a user gesture, and OSC 52 never has one. */
export function systemClipboardWrite(text: string): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
    return Promise.reject(new Error('Clipboard unavailable'));
  }
  return navigator.clipboard.writeText(text);
}

export function copyNotice(ok: boolean, mac: boolean): string {
  return ok ? 'Copied' : `Couldn't copy. Hold Shift, select the text, then press ${mac ? 'Cmd' : 'Ctrl'}+C.`;
}

/** How long the notice stays: a failure carries instructions, so it lingers. */
export function copyNoticeMs(ok: boolean): number {
  return ok ? 1600 : 5000;
}
