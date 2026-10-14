// Each release ships with its notes (the release job's --notes-file, which the
// What's New toast links), and its version is the same in every file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

test('this version has release notes', () => {
  const file = path.join(root, 'release-notes', `${version}.md`);
  assert.ok(existsSync(file), `no release notes for ${version}`);
  const notes = readFileSync(file, 'utf8');
  assert.ok(notes.trim().length > 0, `the ${version} notes are empty`);
  assert.doesNotMatch(notes, /\b(TODO|TBD)\b/);
});

test('the 0.2.0 notes cover every area that release planned', () => {
  const notes = readFileSync(path.join(root, 'release-notes', '0.2.0.md'), 'utf8');
  for (const heading of ['Reliability', 'Status', 'Terminal', 'Layout', 'Workflow', 'Distribution']) {
    assert.match(notes, new RegExp(`^## ${heading}$`, 'm'), `no "## ${heading}" section`);
  }
});

test('the lockfile carries the same version', () => {
  const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  assert.equal(lock.version, version);
  assert.equal(lock.packages[''].version, version);
});
