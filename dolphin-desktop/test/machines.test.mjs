// Finding machines to connect to without asking: ~/.ssh/config, shell history,
// known_hosts and Tailscale, each read locally.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { detectMachines, parseHistory, parseKnownHosts, parseSshConfig, parseTailscale, rememberMachine, validTarget } from '../dist/machines.js';

test('ssh config: named hosts with their user@hostname, wildcards and Match skipped, Include followed', () => {
  const config = `
Host gpu-box
  HostName 10.0.0.7
  User dev
Host *.internal !bastion
  User ops
Host build-01 build-02 # two names
  HostName build.example.com
Match host foo
  User nobody
Include conf.d/*
`;
  const included = { 'conf.d/*': ['Host lab\n  HostName lab.example.org\n'] };
  const found = parseSshConfig(config, (pattern) => included[pattern] ?? []);
  assert.deepEqual(found.map((m) => [m.target, m.detail]), [
    ['gpu-box', 'dev@10.0.0.7'],
    ['build-01', 'build.example.com'],
    ['build-02', 'build.example.com'],
    ['lab', 'lab.example.org'],
  ]);
});

test('shell history: ssh destinations with -l and -p folded in, most used first, local and junk skipped', () => {
  const history = [
    ': 1700000000:0;ssh gpu-box',
    'ssh -N -L 8421:127.0.0.1:8421 dev@1.2.3.4',
    'ssh -p 2222 -l me lab.example.org uptime',
    'ssh gpu-box',
    'cd ~ && ssh -i ~/.ssh/key gpu-box',
    'ssh localhost',
    'ssh "$HOST"',
    'ssh -p22 -- plain-host',
    'git push',
  ].join('\n');
  const found = parseHistory(history);
  assert.deepEqual(found.map((m) => m.target), ['gpu-box', 'plain-host', 'ssh://me@lab.example.org:2222', 'dev@1.2.3.4']);
  assert.match(found[0].detail, /used 3 times/);
});

test('known_hosts: plain names only; hashed, bracketed-port and local entries skipped', () => {
  const text = [
    '|1|abc=|def= ssh-ed25519 AAAA',
    'gpu-box,10.0.0.7 ssh-ed25519 AAAA',
    '[lab]:2222 ssh-ed25519 AAAA',
    'localhost ssh-ed25519 AAAA',
    '@cert-authority *.example ssh-ed25519 AAAA',
  ].join('\n');
  assert.deepEqual(parseKnownHosts(text).map((m) => m.target), ['gpu-box', '10.0.0.7']);
});

test('tailscale: Mac and Linux peers by MagicDNS name, online first; phones, Windows and relays skipped', () => {
  const status = { Peer: {
    a: { HostName: 'studio', DNSName: 'studio.example.ts.net.', OS: 'macOS', Online: false, TailscaleIPs: ['100.0.0.2'] },
    b: { HostName: 'gpu', DNSName: 'gpu.example.ts.net.', OS: 'linux', Online: true, TailscaleIPs: ['100.0.0.3', 'fd00::3'], sshHostKeys: ['ssh-ed25519 AAAA'] },
    c: { HostName: 'phone', DNSName: 'phone.example.ts.net.', OS: 'iOS', Online: true },
    d: { HostName: 'pc', DNSName: 'pc.example.ts.net.', OS: 'windows', Online: true },
    e: { HostName: 'funnel-ingress-node', DNSName: '', OS: '', Online: false },
  } };
  const found = parseTailscale(status);
  assert.deepEqual(found.map((m) => [m.target, m.online]), [['gpu.example.ts.net', true], ['studio.example.ts.net', false]]);
  assert.equal(found[0].detail, 'gpu.example.ts.net · Linux · Tailscale SSH');
  assert.equal(found[1].detail, 'studio.example.ts.net · Mac · offline');
  // Without MagicDNS the names don't resolve, so the Tailscale IP is used.
  const plain = parseTailscale({ ...status, CurrentTailnet: { MagicDNSEnabled: false } });
  assert.deepEqual(plain.map((m) => m.target), ['100.0.0.3', '100.0.0.2']);
});

test('targets are names, user@host or ssh:// addresses, never options', () => {
  assert.equal(validTarget('me@host'), true);
  assert.equal(validTarget('ssh://me@host:2222'), true);
  assert.equal(validTarget('-oProxyCommand=x'), false);
  assert.equal(validTarget('ssh://-F'), false);
});

test('recent machines come first and appear once', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'dm-'));
  try {
    rememberMachine(home, 'gpu-box');
    rememberMachine(home, 'me@lab');
    rememberMachine(home, 'gpu-box');
    const found = await detectMachines(home, home);
    const recent = found.filter((m) => m.source === 'recent').map((m) => m.target);
    assert.deepEqual(recent, ['gpu-box', 'me@lab']);
    assert.equal(found.filter((m) => m.target === 'gpu-box').length, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
