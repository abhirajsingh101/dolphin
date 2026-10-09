import { afterEach, describe, expect, it, vi } from 'vitest';

/* api.ts reads window.dolphinDesktop.config once, at import. Each case stubs
   the window first and imports a fresh copy. */
async function loadApi(config?: { apiBase: string; token?: string }) {
  vi.resetModules();
  vi.stubGlobal('window', {
    location: { protocol: 'http:', hostname: 'web.example' },
    ...(config ? { dolphinDesktop: { config } } : {}),
  });
  return import('./api');
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Dolphin Desktop runtime config', () => {
  it('leaves the web app on the same host at :8400 with no token', async () => {
    const api = await loadApi();
    expect(api.API_BASE).toBe('http://web.example:8400');
    expect(api.authHeaders()).toEqual({});
    expect(api.withToken('http://web.example:8400/x')).toBe('http://web.example:8400/x');
    expect(api.notificationStreamUrl).toBe('http://web.example:8400/api/notifications/stream');
  });

  it('uses the helper the desktop app hands over, with its token', async () => {
    const api = await loadApi({ apiBase: 'http://127.0.0.1:43123', token: 'a b&c' });
    expect(api.API_BASE).toBe('http://127.0.0.1:43123');
    expect(api.authHeaders()).toEqual({ 'X-Dolphin-Token': 'a b&c' });
    expect(api.notificationStreamUrl).toBe('http://127.0.0.1:43123/api/notifications/stream?token=a%20b%26c');
    expect(api.tmuxStreamUrl('p1', 'demo')).toMatch(/^ws:\/\/127\.0\.0\.1:43123\/.*\/stream\?token=a%20b%26c$/);
    expect(api.withToken('http://h/x?y=1')).toBe('http://h/x?y=1&token=a%20b%26c');
  });

  it('sends the token header on API requests', async () => {
    const api = await loadApi({ apiBase: 'http://127.0.0.1:43123', token: 'secret' });
    const fetchMock = vi.fn(async () => new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    await api.request('/api/desktop/agents');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:43123/api/desktop/agents');
    expect(new Headers(init.headers).get('X-Dolphin-Token')).toBe('secret');
  });
});
