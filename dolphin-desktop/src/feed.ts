/* One machine's notification stream, read by the main process itself, so
   finished turns arrive while the window is unfocused, hidden or closed.
   Server-sent events over fetch; reconnects until stopped. No Electron here. */

import { isTurnNotification, type TurnNotification } from './notify';

export type Feed = { stop: () => void };

/** Feed it text as it arrives; it calls back once per complete event. */
export function sseParser(onEvent: (event: string, data: string) => void): (chunk: string) => void {
  let buffer = '';
  return (chunk) => {
    // Normalise the whole buffer, so a CRLF split across chunks still joins.
    buffer = (buffer + chunk).replace(/\r\n/g, '\n');
    let end = buffer.indexOf('\n\n');
    while (end >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      let event = 'message';
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (!line || line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'event') event = value;
        else if (field === 'data') data.push(value);
      }
      if (data.length) onEvent(event, data.join('\n'));
      end = buffer.indexOf('\n\n');
    }
  };
}

export function openFeed({ url, token, onNotification, retryMs = 5_000, maxRetryMs = 60_000, idleMs = 60_000, fetchImpl = fetch }: {
  url: string; token: string; onNotification: (item: TurnNotification) => void; retryMs?: number; maxRetryMs?: number; idleMs?: number; fetchImpl?: typeof fetch;
}): Feed {
  let stopped = false;
  let controller: AbortController | null = null;
  let wake: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let delay = retryMs;
  const run = async () => {
    while (!stopped) {
      const current = new AbortController();
      controller = current;
      let delivered = false;
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      // A half-open socket never errors; no bytes (heartbeats included) for idleMs means it is dead.
      const touch = () => { clearTimeout(watchdog); watchdog = setTimeout(() => current.abort(), idleMs); };
      try {
        touch();
        // Accept: text/event-stream is how the helper knows not to gzip (and buffer) the stream.
        const response = await fetchImpl(url, { headers: { Accept: 'text/event-stream', 'X-Dolphin-Token': token }, signal: current.signal });
        if (!response.ok || !response.body) { void response.body?.cancel().catch(() => {}); throw new Error(`HTTP ${response.status}`); }
        const decoder = new TextDecoder();
        const feed = sseParser((event, data) => {
          if (event !== 'notification') return;
          try {
            const item: unknown = JSON.parse(data);
            if (isTurnNotification(item) && !item.read) onNotification(item);
          } catch { /* one bad event never stops the stream */ }
        });
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) { touch(); delivered = true; feed(decoder.decode(chunk, { stream: true })); }
      } catch { /* dropped, refused or stopped: try again below unless stopped */ } finally { clearTimeout(watchdog); }
      if (stopped) return;
      if (delivered) delay = retryMs;
      const wait = delay;
      delay = Math.min(delay * 2, maxRetryMs);
      await new Promise<void>((resolve) => { wake = resolve; timer = setTimeout(resolve, wait); });
    }
  };
  void run();
  return {
    stop: () => {
      stopped = true;
      controller?.abort();
      clearTimeout(timer);
      wake?.();
    },
  };
}
