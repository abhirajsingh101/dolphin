import { describe, expect, it } from 'vitest';
import { filterMachines, validTarget, type Machine } from './machines';

const machines: Machine[] = [
  { target: 'gpu-box', label: 'gpu-box', detail: 'dev@10.0.0.7', source: 'config' },
  { target: 'studio.example.ts.net', label: 'studio', detail: 'studio.example.ts.net · Mac', source: 'tailscale', online: true },
  { target: 'me@build-01', label: 'build-01', source: 'history' },
];

describe('machines', () => {
  it('accepts names, user@host and ssh:// addresses, never an option', () => {
    expect(validTarget('gpu-box')).toBe(true);
    expect(validTarget('me@10.0.0.5')).toBe(true);
    expect(validTarget('ssh://me@host:2222')).toBe(true);
    expect(validTarget('-oProxyCommand')).toBe(false);
    expect(validTarget('ssh://-oProxyCommand')).toBe(false);
    expect(validTarget('host; rm -rf ~')).toBe(false);
    expect(validTarget('')).toBe(false);
  });

  it('ranks names that start with the query first, then contain it, then the detail', () => {
    expect(filterMachines(machines, '').map((m) => m.label)).toEqual(['gpu-box', 'studio', 'build-01']);
    expect(filterMachines(machines, 'stu').map((m) => m.label)).toEqual(['studio']);
    expect(filterMachines(machines, 'b').map((m) => m.label)).toEqual(['build-01', 'gpu-box']);
    expect(filterMachines(machines, '10.0.0.7').map((m) => m.label)).toEqual(['gpu-box']);
    expect(filterMachines(machines, 'nothing')).toEqual([]);
  });
});
