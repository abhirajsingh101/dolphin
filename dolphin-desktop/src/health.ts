/* Is a helper answering? Every request has its own deadline: a tunnel that
 * accepts connections but never answers must not hang the caller past its
 * own. No Electron here (test/health.test.mjs). */

export async function healthOnce(apiBase: string, timeoutMs = 5_000, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(`${apiBase}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    void response.body?.cancel().catch(() => {});
    return response.ok;
  } catch {
    return false;
  }
}

export async function waitHealthy(apiBase: string, timeoutMs = 45_000, options: { fetchTimeoutMs?: number; pollMs?: number; fetchImpl?: typeof fetch } = {}): Promise<void> {
  const { fetchTimeoutMs = 3_000, pollMs = 250, fetchImpl = fetch } = options;
  const deadline = Date.now() + timeoutMs;
  let last = 'no answer';
  while (Date.now() < deadline) {
    const wait = Math.max(1, Math.min(fetchTimeoutMs, deadline - Date.now()));
    try {
      const response = await fetchImpl(`${apiBase}/health`, { signal: AbortSignal.timeout(wait) });
      void response.body?.cancel().catch(() => {});
      if (response.ok) return;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error instanceof Error && error.name === 'TimeoutError' ? `no answer within ${wait} ms` : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`Dolphin's helper did not answer (${last}).`);
}
