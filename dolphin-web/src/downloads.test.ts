import { describe, expect, it } from 'vitest';
import { downloadDetail, downloadsLabel, formatBytes, fractionOf, overallProgress, type Download } from './downloads';

const base: Download = { id: 'd1', name: 'notes.md', file: '/Users/me/Downloads/notes.md', machine: 'gpu-box', received: 0, total: 0, state: 'progressing', started: 1 };

describe('formatBytes', () => {
  it('uses decimal units like Finder', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(999)).toBe('999 B');
    expect(formatBytes(1200)).toBe('1.2 KB');
    expect(formatBytes(4_000_000)).toBe('4.0 MB');
    expect(formatBytes(52_400_000)).toBe('52 MB');
    expect(formatBytes(3_100_000_000)).toBe('3.1 GB');
  });
});

describe('downloadDetail', () => {
  it('says how far along, what finished, and why one stopped', () => {
    expect(downloadDetail({ ...base, received: 1_200_000, total: 4_000_000 })).toBe('1.2 MB of 4.0 MB · gpu-box');
    expect(downloadDetail({ ...base, received: 1_200_000 })).toBe('1.2 MB · gpu-box');
    expect(downloadDetail({ ...base, state: 'completed', received: 11, total: 11 })).toBe('11 B · gpu-box · Saved to Downloads');
    expect(downloadDetail({ ...base, state: 'cancelled', machine: undefined })).toBe('Cancelled');
    expect(downloadDetail({ ...base, state: 'failed', error: 'Stopped: check that gpu-box is still connected, then click the path again.' }))
      .toBe('Stopped: check that gpu-box is still connected, then click the path again.');
  });
});

describe('progress', () => {
  it('adds up what is downloading, and is unknown when any size is', () => {
    expect(fractionOf({ ...base, received: 1, total: 4 })).toBe(0.25);
    expect(fractionOf(base)).toBeNull();
    expect(fractionOf({ ...base, state: 'completed' })).toBe(1);
    const list = [{ ...base, received: 1, total: 4 }, { ...base, id: 'd2', received: 3, total: 4 }, { ...base, id: 'd3', state: 'completed' as const }];
    expect(overallProgress(list)).toEqual({ active: 2, fraction: 0.5 });
    expect(overallProgress([...list, { ...base, id: 'd4' }])).toEqual({ active: 3, fraction: null });
    expect(overallProgress([])).toEqual({ active: 0, fraction: null });
    expect(downloadsLabel(list)).toBe('Downloads, 2 in progress');
    expect(downloadsLabel([list[2]])).toBe('Downloads');
  });
});
