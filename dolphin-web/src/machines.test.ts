import { describe, expect, it } from 'vitest';
import { filterMachines, terminalReconnectKey, validTarget, type Machine } from './machines';

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

describe('terminalReconnectKey', () => {
  const links = [{ id: 'local', epoch: 0 }, { id: 'gpu', epoch: 2 }];
  it('is the same before and after the project list arrives when the target carries its machine', () => {
    const target = { projectId: 'atlas', machine: 'gpu' };
    const before = terminalReconnectKey(target, [], links);
    const after = terminalReconnectKey(target, [{ id: 'atlas', machine: 'gpu' }], links);
    expect(before).toBe('gpu:2');
    expect(after).toBe(before);
  });
  it('does not invent a local key while the machine is still unknown', () => {
    expect(terminalReconnectKey({ projectId: 'atlas' }, [], links, true)).toBeUndefined();
    expect(terminalReconnectKey({ projectId: 'atlas' }, [{ id: 'atlas', machine: 'gpu' }], links, true)).toBe('gpu:2');
  });
  it('moves with the epoch', () => {
    expect(terminalReconnectKey({ projectId: 'a', machine: 'gpu' }, [], [{ id: 'gpu', epoch: 3 }])).toBe('gpu:3');
  });
});
