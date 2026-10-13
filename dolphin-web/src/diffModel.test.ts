import { describe, expect, it } from 'vitest';
import { parseDiff, reviewPrompt } from './diffModel';

const MODIFIED = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,3 +1,3 @@',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  ' --- not a header inside a hunk',
  '',
].join('\n');

describe('parseDiff', () => {
  it('numbers old and new lines', () => {
    const [file] = parseDiff(MODIFIED);
    expect(file.path).toBe('src/app.ts');
    expect(file.status).toBe('modified');
    expect(file.hunks[0].lines).toEqual([
      { kind: 'context', text: 'const a = 1;', oldLine: 1, newLine: 1 },
      { kind: 'del', text: 'const b = 2;', oldLine: 2, newLine: null },
      { kind: 'add', text: 'const b = 3;', oldLine: null, newLine: 2 },
      { kind: 'context', text: '--- not a header inside a hunk', oldLine: 3, newLine: 3 },
    ]);
  });
  it('reads added, deleted, renamed and binary files', () => {
    const text = [
      'diff --git a/new.txt b/new.txt', 'new file mode 100644', '--- /dev/null', '+++ b/new.txt', '@@ -0,0 +1 @@', '+hello',
      'diff --git a/gone.txt b/gone.txt', 'deleted file mode 100644', '--- a/gone.txt', '+++ /dev/null', '@@ -1 +0,0 @@', '-bye',
      'diff --git a/old.md b/new.md', 'similarity index 100%', 'rename from old.md', 'rename to new.md',
      'diff --git a/logo.png b/logo.png', 'Binary files a/logo.png and b/logo.png differ',
      '\\ No newline at end of file', '',
    ].join('\n');
    expect(parseDiff(text).map((f) => [f.path, f.status, f.oldPath, f.binary])).toEqual([
      ['new.txt', 'added', null, false],
      ['gone.txt', 'deleted', null, false],
      ['new.md', 'renamed', 'old.md', false],
      ['logo.png', 'modified', null, true],
    ]);
  });
  it('is empty for no changes', () => {
    expect(parseDiff('')).toEqual([]);
  });
});

describe('reviewPrompt', () => {
  it('turns comments into one numbered prompt', () => {
    expect(reviewPrompt([
      { path: 'src/app.ts', line: 2, side: 'new', code: 'const b = 3;', text: 'Keep b at 2' },
      { path: 'src/app.ts', line: 2, side: 'old', code: 'const b = 2;', text: 'Why remove this?\nIt is used.' },
      { path: 'README.md', line: null, side: 'new', code: '', text: '  ' },
    ])).toBe([
      'Review comments on your changes. Address each one, then summarise what you changed.',
      '',
      '1. src/app.ts:2',
      '   > const b = 3;',
      '   Keep b at 2',
      '2. src/app.ts:2 (removed line)',
      '   > const b = 2;',
      '   Why remove this?',
      '   It is used.',
    ].join('\n'));
  });
  it('is empty without comments', () => {
    expect(reviewPrompt([])).toBe('');
  });
});

describe('reviewPrompt and untrusted text', () => {
  it('drops control characters from comments and code, keeping line breaks', () => {
    const prompt = reviewPrompt([{ path: 'a\u001b[2Jb.ts', line: 1, side: 'new', code: 'x\u0003y\u007f', text: 'one\u001b[31m\r\ntwo\u0000\tthree' }]);
    expect(prompt).toBe([
      'Review comments on your changes. Address each one, then summarise what you changed.',
      '',
      '1. a[2Jb.ts:1',
      '   > xy',
      '   one[31m',
      '   two three',
    ].join('\n'));
    // eslint-disable-next-line no-control-regex
    expect(prompt).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f]/);
  });
});
