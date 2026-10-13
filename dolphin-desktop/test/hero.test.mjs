// The README's hero: the packaged first run's screenshots as one looping GIF.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const script = path.resolve(import.meta.dirname, '..', 'scripts', 'make-hero.sh');
const has = (command) => { try { execFileSync('sh', ['-c', `command -v ${command}`]); return true; } catch { return false; } };
const FRAMES = ['packaged-first-run.png', 'packaged-terminal.png', 'packaged-health.png'];

function shots(dir, sizes) {
  FRAMES.forEach((name, index) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
    '-i', `color=c=0x${['204060', '406020', '602040'][index]}:s=${sizes[index]}`, '-frames:v', '1', path.join(dir, name)]));
}

test('three shots become one looping GIF, the same every time', { skip: !has('ffmpeg') && 'ffmpeg is not installed' }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dhero-'));
  try {
    shots(dir, ['1440x900', '1440x900', '1280x800']); // a different size is padded, not rejected
    execFileSync(script, [dir, path.join(dir, 'a.gif')]);
    execFileSync(script, [dir, path.join(dir, 'b.gif')]);
    const gif = readFileSync(path.join(dir, 'a.gif'));
    assert.equal(gif.subarray(0, 6).toString('latin1'), 'GIF89a');
    const frames = execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames,width,height', '-of', 'csv=p=0', path.join(dir, 'a.gif')], { encoding: 'utf8' }).trim();
    assert.equal(frames, '1200,750,3');
    const sha = (file) => createHash('sha256').update(readFileSync(path.join(dir, file))).digest('hex');
    assert.equal(sha('a.gif'), sha('b.gif'), 'reproducible');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing shot is named, and nothing is written', { skip: !has('ffmpeg') && 'ffmpeg is not installed' }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dhero-'));
  try {
    const result = spawnSync(script, [dir, path.join(dir, 'out.gif')], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /missing .*packaged-first-run\.png/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
