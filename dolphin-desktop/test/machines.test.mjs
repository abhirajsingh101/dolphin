// Finding machines to connect to without asking: ~/.ssh/config, shell history
// and known_hosts, each read locally.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { detectMachines, parseHistory, parseKnownHosts, parseSshConfig, rememberMachine, validTarget } from '../dist/machines.js';

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
