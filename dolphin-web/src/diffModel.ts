/* A unified diff (git diff output) as files, hunks and numbered lines, and the
   review comments made on them as one prompt for the session's agent. */

export type DiffLine = { kind: 'context' | 'add' | 'del'; text: string; oldLine: number | null; newLine: number | null };
export type DiffHunk = { header: string; lines: DiffLine[] };
export type DiffFile = { path: string; oldPath: string | null; status: 'modified' | 'added' | 'deleted' | 'renamed'; binary: boolean; hunks: DiffHunk[] };
export type ReviewComment = { path: string; line: number | null; side: 'old' | 'new'; code: string; text: string };

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  for (const raw of text.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      const match = /^diff --git a\/(.*) b\/(.*)$/.exec(raw);
      file = { path: match?.[2] ?? raw.slice(11), oldPath: null, status: 'modified', binary: false, hunks: [] };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;
    const header = HUNK.exec(raw);
    if (header) {
      hunk = { header: raw, lines: [] };
      file.hunks.push(hunk);
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      continue;
    }
    if (!hunk) {
      if (raw.startsWith('new file mode')) file.status = 'added';
      else if (raw.startsWith('deleted file mode')) file.status = 'deleted';
      else if (raw.startsWith('rename from ')) { file.oldPath = raw.slice(12); file.status = 'renamed'; }
      else if (raw.startsWith('rename to ')) file.path = raw.slice(10);
      else if (raw.startsWith('Binary files ')) file.binary = true;
      else if (raw === '+++ /dev/null') file.status = 'deleted';
      else if (raw.startsWith('+++ b/')) file.path = raw.slice(6);
      continue;
    }
    if (raw.startsWith('+')) hunk.lines.push({ kind: 'add', text: raw.slice(1), oldLine: null, newLine: newLine++ });
    else if (raw.startsWith('-')) hunk.lines.push({ kind: 'del', text: raw.slice(1), oldLine: oldLine++, newLine: null });
    else if (raw.startsWith(' ')) hunk.lines.push({ kind: 'context', text: raw.slice(1), oldLine: oldLine++, newLine: newLine++ });
    // "\ No newline at end of file" and the final empty string carry no line.
  }
  return files;
}

/** The prompt is pasted into a terminal: no control character (escape, NUL, C1) may ride along in a comment, a path or a line of code. Tabs become a space; line breaks stay. */
export function plain(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\r\n?/g, '\n').replace(/\t/g, ' ').replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, '');
}

export function reviewPrompt(rawComments: ReviewComment[]): string {
  const comments = rawComments.map((comment) => ({ ...comment, path: plain(comment.path).replace(/\n/g, ' '), code: plain(comment.code).replace(/\n/g, ' '), text: plain(comment.text) }));
  const items = comments.filter((comment) => comment.text.trim());
  if (!items.length) return '';
  const lines = ['Review comments on your changes. Address each one, then summarise what you changed.', ''];
  items.forEach((comment, index) => {
    const where = comment.line === null ? comment.path : `${comment.path}:${comment.line}${comment.side === 'old' ? ' (removed line)' : ''}`;
    lines.push(`${index + 1}. ${where}`);
    if (comment.code.trim()) lines.push(`   > ${comment.code.trim()}`);
    for (const line of comment.text.trim().split('\n')) lines.push(`   ${line}`);
  });
  return lines.join('\n');
}
