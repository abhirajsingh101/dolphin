// The Homebrew cask the release job renders: this version, both dmgs' sha256,
// and URLs that match the names the build produces.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { caskFromRelease, renderCask } from '../scripts/render-cask.mjs';
import { expectedInstallers } from '../scripts/check-artifacts.mjs';

const root = path.resolve(import.meta.dirname, '..');
const template = readFileSync(path.join(root, 'packaging', 'homebrew', 'dolphin-desktop.rb.in'), 'utf8');
const sums = { arm64: 'a'.repeat(64), x64: 'b'.repeat(64) };
const has = (command) => { try { execFileSync('sh', ['-c', `command -v ${command}`]); return true; } catch { return false; } };

test('the cask names this version and both dmgs', () => {
  const cask = renderCask(template, { version: '0.2.0', ...sums });
  assert.match(cask, /^cask "dolphin-desktop" do$/m);
  assert.match(cask, /version "0\.2\.0"/);
  assert.match(cask, new RegExp(`arm:\\s+"${sums.arm64}"`));
  assert.match(cask, new RegExp(`intel: "${sums.x64}"`));
  assert.doesNotMatch(cask, /@[A-Z0-9_]+@/);
  // The URL pattern, expanded for each arch, is exactly the build's dmg name.
  const url = /url "([^"]+)"/.exec(cask)[1];
  for (const [arch, target] of [['arm64', 'darwin-arm64'], ['x64', 'darwin-x64']]) {
    const name = url.replaceAll('#{version}', '0.2.0').replaceAll('#{arch}', arch).split('/').pop();
    assert.ok(expectedInstallers('0.2.0', target).includes(name), `${name} is a ${target} installer`);
  }
});

test('casks follow stable releases only, and need both checksums', () => {
  assert.throws(() => renderCask(template, { version: '0.2.1-beta.1', ...sums }), /not a stable version/);
  assert.throws(() => renderCask(template, { version: '0.2.0', arm64: sums.arm64, x64: 'nope' }), /no sha256 for the x64 dmg/);
  assert.throws(() => renderCask(`${template}\n@EXTRA@`, { version: '0.2.0', ...sums }), /placeholder/);
});

test('the script hashes the release\'s dmgs', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dcask-'));
  try {
    writeFileSync(path.join(dir, 'Dolphin-0.2.0-mac-arm64.dmg'), 'arm');
    writeFileSync(path.join(dir, 'Dolphin-0.2.0-mac-x64.dmg'), 'intel');
    const sha = (text) => createHash('sha256').update(text).digest('hex');
    assert.equal(caskFromRelease(dir, '0.2.0'), renderCask(template, { version: '0.2.0', arm64: sha('arm'), x64: sha('intel') }));
    const printed = execFileSync(process.execPath, [path.join(root, 'scripts', 'render-cask.mjs'), dir, '0.2.0'], { encoding: 'utf8' });
    assert.equal(printed, caskFromRelease(dir, '0.2.0'));
    rmSync(path.join(dir, 'Dolphin-0.2.0-mac-x64.dmg'));
    assert.throws(() => caskFromRelease(dir, '0.2.0'), /Dolphin-0\.2\.0-mac-x64\.dmg/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the rendered cask is valid Ruby', { skip: !has('ruby') && 'ruby is not installed' }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dcask-'));
  try {
    writeFileSync(path.join(dir, 'dolphin-desktop.rb'), renderCask(template, { version: '0.2.0', ...sums }));
    assert.match(execFileSync('ruby', ['-c', path.join(dir, 'dolphin-desktop.rb')], { encoding: 'utf8' }), /Syntax OK/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
