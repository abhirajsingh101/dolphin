import { describe, expect, it, vi } from 'vitest';
import { fileLinkTitle, fileManagerName, openTerminalFile } from './openFile';

describe('fileManagerName', () => {
  it('names each OS file manager', () => {
    expect(fileManagerName('darwin')).toBe('Finder');
    expect(fileManagerName('MacIntel')).toBe('Finder');
    expect(fileManagerName('win32')).toBe('File Explorer');
    expect(fileManagerName('linux')).toBe('the file manager');
  });
});

describe('fileLinkTitle', () => {
  it('says what a click does on this computer and on a machine over SSH', () => {
    expect(fileLinkTitle('/a/b.txt', 'local', 'darwin')).toBe('Show /a/b.txt in Finder');
    expect(fileLinkTitle('/a/b.txt', undefined, 'win32')).toBe('Show /a/b.txt in File Explorer');
    expect(fileLinkTitle('/a/b.txt', 'gpu-box', 'darwin')).toBe("Download /a/b.txt to this computer's Downloads");
  });
});

describe('openTerminalFile', () => {
  it('is false without the Desktop bridge, so the caller downloads as before', () => {
    expect(openTerminalFile('/a/b.txt', 'gpu-box', vi.fn(), null)).toBe(false);
    expect(openTerminalFile('/a/b.txt', 'gpu-box', vi.fn(), {})).toBe(false);
  });

  it('shows a file on this computer without a notice', async () => {
    const say = vi.fn();
    const openFile = vi.fn(async (_machine: string, file: string) => ({ shown: file }));
    expect(openTerminalFile('/a/b.txt', undefined, say, { openFile })).toBe(true);
    await vi.waitFor(() => expect(openFile).toHaveBeenCalledWith('local', '/a/b.txt'));
    await Promise.resolve();
    expect(say).not.toHaveBeenCalled();
  });

  it('says a download from a machine started and where it was saved', async () => {
    const say = vi.fn();
    const openFile = vi.fn(async () => ({ saved: '/Users/me/Downloads/b (1).txt' }));
    openTerminalFile('/srv/b.txt', 'gpu-box', say, { openFile });
    expect(say).toHaveBeenNthCalledWith(1, 'Downloading b.txt…', 60_000);
    await vi.waitFor(() => expect(say).toHaveBeenNthCalledWith(2, 'Saved b (1).txt to Downloads.', 4000));
    expect(openFile).toHaveBeenCalledWith('gpu-box', '/srv/b.txt');
  });

  it('shows the error the app gives, or the one it throws', async () => {
    const say = vi.fn();
    openTerminalFile('/srv/b.txt', 'gpu-box', say, { openFile: async () => ({ error: 'gpu-box is not connected.' }) });
    await vi.waitFor(() => expect(say).toHaveBeenLastCalledWith('gpu-box is not connected.', 4000));
    openTerminalFile('/a', 'local', say, { openFile: async () => { throw new Error('bridge gone'); } });
    await vi.waitFor(() => expect(say).toHaveBeenLastCalledWith('bridge gone', 4000));
  });
});
