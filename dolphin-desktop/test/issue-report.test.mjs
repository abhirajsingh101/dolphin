// Report an Issue…: what goes into the pre-filled GitHub issue, and what never does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { environmentText, ISSUE_URL, issueUrl, MAX_URL, scrub, tailLines } from '../dist/issueReport.js';

const root = path.resolve(import.meta.dirname, '..');
const context = { home: '/home/alice', user: 'alice', hostnames: ['alice-laptop.local', 'alice-laptop', 'gpu-box'], secrets: ['tok_0123456789abcdef'] };
const facts = { appVersion: '0.2.0', channel: 'stable', platform: 'linux', osRelease: '6.8.0', arch: 'x64', helperVersion: '0.2.0',
  tmux: { version: '3.4', bundled: false }, sshMachines: 2, logLines: [] };

test('home paths, names, hosts, addresses, tokens and emails are removed; timestamps stay', () => {
  const cases = [
    ['2026-10-12T10:11:12 opened /home/alice/projects/secret-app', '2026-10-12T10:11:12 opened ~/projects/secret-app'],
    ['read /Users/bob/x', 'read ~/x'],
    ['ssh alice@10.0.0.5 failed', 'ssh <user>@<host> failed'],
    ['connected to gpu-box.tail1234.ts.net (192.0.2.10)', 'connected to <host> (<ip>)'],
    ['ALICE-LAPTOP.local and gpu-box answered', '<host> and <host> answered'],
    ['GET /api/x?token=tok_0123456789abcdef&y=1', 'GET /api/x?token=<redacted>&y=1'],
    ['ws?token=abc123def&x=1', 'ws?token=<redacted>&x=1'],
    ['mail alice@example.com', 'mail <email>'],
    ['listening on 127.0.0.1:43123', 'listening on 127.0.0.1:43123'],
    ['peer fd00:1:2:3::1234 joined at 10:11:12', 'peer <ip> joined at 10:11:12'],
    ['key 0123456789abcdef0123456789abcdef01', 'key <redacted>'],
    ['user alice started', 'user <user> started'],
  ];
  for (const [line, expected] of cases) assert.equal(scrub(line, context), expected, line);
});

test('the issue is pre-filled for the bug report form', () => {
  const url = new URL(issueUrl({ ...facts, logLines: ['opened /home/alice/app on gpu-box'] }, context));
  assert.equal(`${url.origin}${url.pathname}`, ISSUE_URL);
  assert.equal(url.searchParams.get('template'), 'bug_report.yml');
  assert.equal(url.searchParams.get('version'), '0.2.0');
  assert.equal(url.searchParams.get('environment'), environmentText(facts));
  assert.equal(url.searchParams.get('logs'), 'opened ~/app on <host>');
  assert.equal(environmentText(facts), 'Dolphin 0.2.0 (stable channel)\nLinux 6.8.0, x64\nHelper 0.2.0, tmux 3.4\nMachines over SSH: 2');
  assert.match(environmentText({ ...facts, helperVersion: null, tmux: null }), /Helper unknown, tmux unknown/);
});

test('a long log is cut from the top until the URL fits', () => {
  const logLines = Array.from({ length: 500 }, (_, index) => `line ${index} ${'x'.repeat(280)}`);
  const url = issueUrl({ ...facts, logLines }, context);
  assert.ok(url.length <= MAX_URL, `${url.length} > ${MAX_URL}`);
  const logs = new URL(url).searchParams.get('logs');
  assert.ok(logs.endsWith(`line 499 ${'x'.repeat(280)}`), 'the newest lines are kept');
});

test('the form\'s field ids are the ones the URL fills', () => {
  const file = [path.join(root, '..', 'public', 'overlay', '.github', 'ISSUE_TEMPLATE', 'bug_report.yml'),
    path.join(root, '..', '.github', 'ISSUE_TEMPLATE', 'bug_report.yml')].find(existsSync);
  const ids = [...readFileSync(file, 'utf8').matchAll(/^\s+id: (\S+)$/gm)].map((match) => match[1]);
  assert.deepEqual(ids, ['what-happened', 'version', 'environment', 'logs']);
});

test('the log tail reads only the end of a big file', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dtail-'));
  try {
    const file = path.join(dir, 'helper.log');
    writeFileSync(file, Array.from({ length: 20_000 }, (_, index) => `line ${index}`).join('\n') + '\n');
    assert.deepEqual(tailLines(file, 3), ['line 19997', 'line 19998', 'line 19999']);
    assert.deepEqual(tailLines(path.join(dir, 'missing.log'), 3), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('every SSH machine\'s user, host and alias are removed, and so are key-shaped strings', () => {
  const ssh = { ...context, users: ['builder'], hostnames: [...context.hostnames, 'build-7', 'prod-alias'] };
  const cases = [
    ['builder ran on build-7 via prod-alias', '<user> ran on <host> via <host>'],
    ['Authorization: Bearer abc.def-ghi_jkl123', 'Authorization: Bearer <redacted>'],
    ['OPENAI sk-proj-AbCd1234efGh5678', 'OPENAI <redacted>'],
    ['pushed with ghp_AbCdEf1234567890xyz', 'pushed with <redacted>'],
    ['blob QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5+/== end', 'blob <redacted> end'],
    ['sha 0123456789abcdef0123456789abcdef', 'sha <redacted>'],
    ['v6 2001:db8::8a2e:370:7334 up', 'v6 <ip> up'],
  ];
  for (const [line, expected] of cases) assert.equal(scrub(line, ssh), expected, line);
});

test('secrets are scrubbed before the cut, so a cut never leaves half of one', () => {
  const secret = 'tok_0123456789abcdef';
  const line = `${'y'.repeat(290)} ${secret}`;
  const logs = new URL(issueUrl({ ...facts, logLines: [line] }, context)).searchParams.get('logs');
  assert.ok(!logs.includes('tok_'), logs.slice(-40));
  assert.ok(!logs.includes('0123456789'), logs.slice(-40));
});

const review = { ...context, users: ['root', 'builder', 'alice'], hostnames: [...context.hostnames, 'stage', 'prod.example.org', 'gpu-box.corp.example.com'], secrets: [...context.secrets, 'abcdefghijklmnopqrstuvwxyz0123456789'] };
const REVIEW_CASES = [
  // compressed IPv6, and what must stay
  ['at 2001:db8::1 now', 'at <ip> now'],
  ['at fd00::1 now', 'at <ip> now'],
  ['at fe80::1%eth0 now', 'at <ip> now'],
  ['ssh [2001:db8::1]:22 failed', 'ssh [<ip>]:22 failed'],
  ['at 12:30:45 sharp', 'at 12:30:45 sharp'],
  ['tmux 3.4.5.6 and v1.2.3.4 and version 9.8.7.6', 'tmux 3.4.5.6 and v1.2.3.4 and version 9.8.7.6'],
  ['peer 300.1.1.1 odd', 'peer 300.1.1.1 odd'],
  // key-like strings: slashes no longer exempt, plain paths keep their words
  ['aws wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY end', 'aws <redacted> end'],
  ['x secret/QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5 y', 'x <redacted> y'],
  ['load /usr/lib/x86_64-linux-gnu/some/long/library/path.so', 'load /usr/lib/x86_64-linux-gnu/some/long/library/path.so'],
  ['open src/components/something/deeply/nested/file.ts', 'open src/components/something/deeply/nested/file.ts'],
  ['file /tmp/QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5', 'file /tmp/<redacted>'],
  ['filler ' + 'x'.repeat(60), 'filler ' + 'x'.repeat(60)],
  // credential shapes
  ['id AKIAIOSFODNN7EXAMPLE ok', 'id <redacted> ok'],
  ['Authorization: Basic dXNlcjpwYXNz', 'Authorization: Basic <redacted>'],
  ['Authorization: token ghx123', 'Authorization: token <redacted>'],
  ['bot xoxb-1234-abcd-efgh9999', 'bot <redacted>'],
  ['pat github_pat_11ABCDEFG0abcdefghij_klmnop', 'pat <redacted>'],
  ['jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJl end', 'jwt <redacted> end'],
  // key/value forms
  ['GET /x?api_key=abc123&y=1', 'GET /x?api_key=<redacted>&y=1'],
  ['X-Dolphin-Token: abc123def', 'X-Dolphin-Token: <redacted>'],
  ['body {"token":"abc123def","n":1}', 'body {"token":"<redacted>","n":1}'],
  ['password: hunter2', 'password: <redacted>'],
  ['AWS_SECRET_ACCESS_KEY=abc/def', 'AWS_SECRET_ACCESS_KEY=<redacted>'],
  ['Cookie: sid=abc; theme=dark', 'Cookie: <redacted>'],
  // user names
  ['root cause: disk full', 'root cause: disk full'],
  ['opened /root/.config/x', 'opened ~/.config/x'],
  ['C:\\Users\\Bo\\Desktop\\x', '~\\Desktop\\x'],
  ['/srv/Alice/work', '/srv/<user>/work'],
  ['/srv/builder/work', '/srv/<user>/work'],
  ['ALICE started, builder done, buildering', '<user> started, <user> done, buildering'],
  // host names on label boundaries, and encoded text
  ['stage-db up, stage up, prod.example.org up', 'stage-db up, <host> up, <host> up'],
  ['prod-db up and prod up', '<host> up and <host> up'],
  ['gpu-box.corp up, gpu-box up, gpu-box.corp.example.com up', '<host> up, <host> up, <host> up'],
  ['path %2Fhome%2Falice%2Fapp at ::%3A', 'path ~/app at :::'],
  ['a=%2Fsrv%2Falice%2Fx', 'a=/srv/<user>/x'],
  // a helper token split over two lines
  ['tail abcdefghijklmnopqrstuvwxyz', 'tail <redacted>'],
  ['uvwxyz0123456789 head', '<redacted> head'],
  // round 2: key as a secret name, more names, quoted values, over-redaction
  ['GET /x?key=hunter2&y=1', 'GET /x?key=<redacted>&y=1'],
  ["key='hunter2' next", "key='<redacted>' next"],
  ['x-api-key = "s3cr3t value" next', 'x-api-key = "<redacted>" next'],
  ['pwd=abc pass: def', 'pwd=<redacted> pass: <redacted>'],
  ['credentials=abc sig=def', 'credentials=<redacted> sig=<redacted>'],
  ['private_key: abc SSH-KEY=def', 'private_key: <redacted> SSH-KEY=<redacted>'],
  ['x_key=abc', 'x_key=<redacted>'],
  ['author: Carol', 'author: Carol'],
  ['authenticated: true', 'authenticated: true'],
  ['tokens: 5 used, tokenizer on', 'tokens: 5 used, tokenizer on'],
  ['keyboard-interactive auth failed', 'keyboard-interactive auth failed'],
  ['monkey: 1 turkey=2', 'monkey: 1 turkey=2'],
  ['alice-x and alice-laptop-2 ran', '<user> and <host> ran'],
  ['id 123e4567-e89b-12d3-a456-426614174000 ok', 'id 123e4567-e89b-12d3-a456-426614174000 ok'],
  ['commit 0123456789abcdef0123456789abcdef01234567 ok', 'commit 0123456789abcdef0123456789abcdef01234567 ok'],
  ['middle ghijklmnopqrstuvwxyz0123 here', 'middle <redacted> here'],
];

test('review: compressed IPv6, key shapes, credentials, users, hosts, encoding, split tokens', () => {
  const failures = [];
  for (const [line, expected] of REVIEW_CASES) {
    const actual = scrub(line, review);
    if (actual !== expected) failures.push(`${JSON.stringify(line)}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`);
  }
  assert.equal(failures.join('\n'), '');
});
