import { afterEach, describe, expect, it, vi } from 'vitest';
import { openLink } from './openLink';

afterEach(() => vi.unstubAllGlobals());

describe('openLink', () => {
  it('asks Dolphin Desktop to open it from the session’s machine', async () => {
    const openUrl = vi.fn(async () => ({ url: 'http://localhost:41000/' }));
    vi.stubGlobal('window', { open: vi.fn() });
    expect(await openLink('http://localhost:3000/', 'gpu-box', { openUrl })).toBeNull();
    expect(openUrl).toHaveBeenCalledWith('gpu-box', 'http://localhost:3000/');
  });
  it('uses this computer when the session has no machine', async () => {
    const openUrl = vi.fn(async () => ({ url: 'http://localhost:3000/' }));
    vi.stubGlobal('window', { open: vi.fn() });
    await openLink('http://localhost:3000/', undefined, { openUrl });
    expect(openUrl).toHaveBeenCalledWith('local', 'http://localhost:3000/');
  });
  it('reports what went wrong', async () => {
    vi.stubGlobal('window', { open: vi.fn() });
    expect(await openLink('http://localhost:3000/', 'gpu-box', { openUrl: async () => ({ error: 'gpu-box is not connected.' }) }))
      .toBe('gpu-box is not connected.');
  });
  it('without Dolphin Desktop opens a new tab', async () => {
    const open = vi.fn();
    vi.stubGlobal('window', { open });
    expect(await openLink('https://example.com/', 'local', null)).toBeNull();
    expect(open).toHaveBeenCalledWith('https://example.com/', '_blank', 'noopener,noreferrer');
  });
  it('refuses anything that is not a web link', async () => {
    const openUrl = vi.fn();
    vi.stubGlobal('window', { open: vi.fn() });
    expect(await openLink('file:///etc/passwd', 'local', { openUrl })).toBe('Only web links open from here.');
    expect(openUrl).not.toHaveBeenCalled();
  });
  it('fails closed when the bridge has no openUrl, instead of opening a tab', async () => {
    const open = vi.fn();
    vi.stubGlobal('window', { open });
    expect(await openLink('http://localhost:3000/', 'gpu-box', {})).toBe('This version of Dolphin Desktop cannot open links from here.');
    expect(open).not.toHaveBeenCalled();
  });
  it('turns a rejected IPC call into a message', async () => {
    vi.stubGlobal('window', { open: vi.fn() });
    const openUrl = vi.fn(async () => { throw new Error('Error invoking remote method'); });
    expect(await openLink('http://localhost:3000/', 'gpu-box', { openUrl })).toBe('Error invoking remote method');
  });
  it('refuses a link with no host', async () => {
    const openUrl = vi.fn();
    vi.stubGlobal('window', { open: vi.fn() });
    expect(await openLink('http://', 'local', { openUrl })).toBe('Only web links open from here.');
    expect(openUrl).not.toHaveBeenCalled();
  });
});
