// The remote install script, run here with sh against scratch folders (no
// ssh): checksum, xz and noexec checks, and pruning old versions. One home
// has a space in its path, as macOS homes can.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { explainRemoteError } from '../dist/remote.js';
import { formatProgress, installScript, pruneScript, sha256File } from '../dist/remote-install.js';

const has = (tool) => spawnSync('sh', ['-c', `command -v ${tool}`]).status === 0;
const canPack = has('xz') && has('tar');

function bundle(dir, helperBody, mode) {
  const src = path.join(dir, 'src', 'dolphin-helper');
  mkdirSync(src, { recursive: true });
  writeFileSync(path.join(src, 'dolphin-helper'), helperBody);
  chmodSync(path.join(src, 'dolphin-helper'), mode);
  const file = path.join(dir, 'bundle.tar.xz');
  execFileSync('tar', ['-cJf', file, '-C', path.join(dir, 'src'), 'dolphin-helper']);
  return file;
}

const install = (home, file, sha, env = process.env) => spawnSync('/bin/sh', ['-c', installScript(home, '9.9.9', sha)], { input: readFileSync(file), env, encoding: 'utf8' });

test('progress reads like "23/57 MB"', () => {
  const mb = 1024 * 1024;
  assert.equal(formatProgress(23 * mb + 10, 57 * mb), '23/57 MB');
  assert.equal(formatProgress(0, 512 * 1024), '0/1 MB');
  assert.equal(formatProgress(57 * mb, 57 * mb), '57/57 MB');
});

test('sha256File matches the known digest', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsha-'));
  try {
    writeFileSync(path.join(dir, 'abc'), 'abc');
    assert.equal(await sha256File(path.join(dir, 'abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a good bundle installs, into a home whose path has a space', { skip: !canPack && 'needs xz and tar' }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dinst-'));
  try {
    const file = bundle(dir, '#!/bin/sh\necho 9.9.9\n', 0o755);
    const home = path.join(dir, 'Shared Work', '.dolphin-server');
    const result = install(home, file, await sha256File(file));
    assert.equal(result.status, 0, result.stderr);
    assert.ok(existsSync(path.join(home, 'versions', '9.9.9', 'dolphin-helper', 'dolphin-helper')));
    assert.deepEqual(readdirSync(path.join(home, 'versions')), ['9.9.9']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a damaged upload is refused and leaves nothing behind', { skip: !canPack && 'needs xz and tar' }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dinst-'));
  try {
    const file = bundle(dir, '#!/bin/sh\necho 9.9.9\n', 0o755);
    const home = path.join(dir, 'home');
    const result = install(home, file, '0'.repeat(64));
    assert.equal(result.status, 65);
    assert.match(result.stderr, /DOLPHIN_BAD_CHECKSUM/);
    assert.deepEqual(readdirSync(path.join(home, 'versions')), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a helper that cannot be executed there is reported as noexec', { skip: !canPack && 'needs xz and tar' }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dinst-'));
  try {
    const file = bundle(dir, '#!/bin/sh\necho 9.9.9\n', 0o644); // exec is refused, as on a noexec mount
    const home = path.join(dir, 'home');
    const result = install(home, file, await sha256File(file));
    assert.equal(result.status, 67);
    assert.match(result.stderr, /DOLPHIN_NOEXEC/);
    assert.deepEqual(readdirSync(path.join(home, 'versions')), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no xz on the machine is said before anything is uploaded', { skip: !canPack && 'needs xz and tar' }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dinst-'));
  try {
    const file = bundle(dir, '#!/bin/sh\necho 9.9.9\n', 0o755);
    const bin = path.join(dir, 'bin');
    mkdirSync(bin);
    for (const tool of ['cat', 'mkdir', 'rm', 'mv', 'cut', 'tar', 'sha256sum', 'shasum']) {
      const found = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
      if (found) symlinkSync(found, path.join(bin, tool));
    }
    const result = install(path.join(dir, 'home'), file, await sha256File(file), { ...process.env, PATH: bin });
    assert.equal(result.status, 66);
    assert.match(result.stderr, /DOLPHIN_NO_XZ/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pruning keeps the current version and the newest other one', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dprune-'));
  try {
    const home = path.join(dir, 'Shared Work', '.dolphin-server');
    const versions = path.join(home, 'versions');
    const ages = { '0.1.9': 400, '0.1.10': 300, '0.1.11': 200, '0.2.0': 100 };
    for (const [version, age] of Object.entries(ages)) {
      mkdirSync(path.join(versions, version), { recursive: true });
      const when = new Date(Date.now() - age * 1000);
      utimesSync(path.join(versions, version), when, when);
    }
    writeFileSync(path.join(versions, '0.2.0.tar.xz'), ''); // a leftover upload is not a version
    execFileSync('/bin/sh', ['-c', pruneScript(home, '0.2.0')]);
    assert.deepEqual(readdirSync(versions).sort(), ['0.1.11', '0.2.0', '0.2.0.tar.xz']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pruning treats a prerelease helper like any other and keeps the current one', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dprune-'));
  try {
    const home = path.join(dir, 'Shared Work', '.dolphin-server');
    const versions = path.join(home, 'versions');
    const ages = { '0.2.1-beta.1': 400, '0.2.1-beta.2': 300, '0.2.0': 200, '0.2.1-beta.3': 100 };
    for (const [version, age] of Object.entries(ages)) {
      mkdirSync(path.join(versions, version), { recursive: true });
      const when = new Date(Date.now() - age * 1000);
      utimesSync(path.join(versions, version), when, when);
    }
    execFileSync('/bin/sh', ['-c', pruneScript(home, '0.2.1-beta.3')]);
    assert.deepEqual(readdirSync(versions).sort(), ['0.2.0', '0.2.1-beta.3']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an install failure, through explainRemoteError, gives the plain message', { skip: !canPack && 'needs xz and tar' }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dinst-'));
  try {
    const file = bundle(dir, '#!/bin/sh\necho 9.9.9\n', 0o644);
    const result = install(path.join(dir, 'home'), file, await sha256File(file));
    // hosts.ts rejects with the remote stderr as the error text.
    const text = explainRemoteError('box', new Error(result.stderr.trim()));
    assert.match(text, /does not allow running programs from its home folder/);
    const bad = install(path.join(dir, 'home2'), file, '0'.repeat(64));
    assert.match(explainRemoteError('box', new Error(bad.stderr.trim())), /arrived damaged/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a stale partial install and upload are cleared by the next install', { skip: !canPack && 'needs xz and tar' }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dinst-'));
  try {
    const file = bundle(dir, '#!/bin/sh\necho 9.9.9\n', 0o755);
    const home = path.join(dir, 'home');
    mkdirSync(path.join(home, 'versions', '9.9.9.part'), { recursive: true });
    writeFileSync(path.join(home, 'versions', '9.9.9.part', 'junk'), 'x');
    writeFileSync(path.join(home, 'versions', '9.9.9.tar.xz'), 'junk');
    const result = install(home, file, await sha256File(file));
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readdirSync(path.join(home, 'versions')), ['9.9.9']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an upload that unpacks badly leaves only the previous version', { skip: !canPack && 'needs xz and tar' }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dinst-'));
  try {
    const file = path.join(dir, 'corrupt.tar.xz');
    writeFileSync(file, 'this is not an xz stream');
    const home = path.join(dir, 'home');
    mkdirSync(path.join(home, 'versions', '9.9.8'), { recursive: true });
    const result = install(home, file, await sha256File(file)); // the checksum matches the corrupt bytes
    assert.notEqual(result.status, 0);
    assert.deepEqual(readdirSync(path.join(home, 'versions')), ['9.9.8']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
