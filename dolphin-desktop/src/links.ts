/* Which links from a page open in the user's browser. Web links and loopback
 * ones (a dev server's localhost:3000) do; Dolphin's own relay and forward
 * ports never do, because their URLs can carry a machine's token. No Electron
 * here (test/links.test.mjs). */

const IPV4 = /^\d+\.\d+\.\d+\.\d+$/;
const MAPPED = /^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/i;
const MAPPED_DOTTED = /^\[::ffff:(\d+\.\d+\.\d+\.\d+)\]$/i;

/** Whether a URL hostname (as `URL.hostname` spells it) means this computer:
 *  localhost and *.localhost (a trailing dot allowed), 127.0.0.0/8, 0.0.0.0,
 *  and the IPv6 forms ::1, :: and ::ffff: mapped ones. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (IPV4.test(host)) return host.startsWith('127.') || host === '0.0.0.0';
  if (host === '[::1]' || host === '[::]') return true;
  const dotted = MAPPED_DOTTED.exec(host);
  if (dotted) return isLoopbackHost(dotted[1]);
  const mapped = MAPPED.exec(host);
  if (mapped) {
    const high = parseInt(mapped[1], 16);
    return (high >> 8) === 127 || (high === 0 && parseInt(mapped[2], 16) === 0);
  }
  return false;
}

/** A dotted public DNS name: not an IP literal, not localhost. Anything else
 *  (a bare name, an address) may be this computer under a spelling we missed. */
function isPublicName(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return host.includes('.') && !host.startsWith('[') && !IPV4.test(host) && !isLoopbackHost(host);
}

/** On a Dolphin port the rule fails closed: only a public DNS name opens.
 *  Accepted residual: a public name that resolves to loopback (e.g. *.nip.io)
 *  cannot be told apart without a DNS lookup, so it opens. */
export function openableExternally(url: string, dolphinPorts: ReadonlySet<number>): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
  if (dolphinPorts.has(port)) return isPublicName(parsed.hostname);
  return true;
}
