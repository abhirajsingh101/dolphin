/* Help → Report an Issue…: a GitHub issue pre-filled for the bug report form
 * (public/overlay/.github/ISSUE_TEMPLATE/bug_report.yml) with versions, the
 * platform and the helper log's last lines. Everything is scrubbed before it
 * goes into the URL: home paths, the user name, host names, SSH targets,
 * tailnet names, addresses, tokens and emails. Nothing is sent; the browser
 * opens the form and the user submits it, or not. No Electron here, so
 * test/issue-report.test.mjs can load it. */

import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

export type IssueFacts = {
  appVersion: string; channel: string; platform: string; osRelease: string; arch: string;
  helperVersion: string | null; tmux: { version: string | null; bundled: boolean } | null;
  sshMachines: number; logLines: string[];
};
export type ScrubContext = { home: string; user: string; /** SSH users of the machine list. */ users?: string[]; hostnames: string[]; secrets: string[] };

export const ISSUE_URL = 'https://github.com/abhirajsingh101/dolphin/issues/new';
/** GitHub refuses much longer issue URLs; this leaves room for the browser. */
export const MAX_URL = 7500;

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Words an account is often called; bare mentions of them are not scrubbed
 *  (paths under them still are). */
const COMMON_USERS = new Set(['root', 'admin', 'user', 'ubuntu', 'deploy', 'ec2-user', 'git']);
/** Secret key names, each a whole word (or hyphen/underscore-joined words), so
 *  "author", "tokens" and "keyboard" are not secrets and "x_key" and "api-key" are. */
const SECRET_NAME = '(?:token|secret|password|passwd|pwd|pass|credentials?|api[_-]?key|apikey|access[_-]?key|private[_-]?key|ssh[_-]?key|key|sig|auth|cookie)';
const KEY_NAME = `(?<![A-Za-z0-9])(?:[A-Za-z0-9]+[-_.])*${SECRET_NAME}(?![A-Za-z0-9])(?:[-_.][A-Za-z0-9]+)*`;

/** A host plus its short name (the first label), as names to scrub. */
export function hostNames(host: string): string[] {
  const first = host.split('.')[0];
  return first && first !== host && !/^\d+$/.test(first) && !host.includes(':') ? [host, first] : [host];
}

/** A run of key-looking characters: redact when it has the mix of a secret. */
function keyLike(run: string): boolean {
  if (new Set(run).size < 6) return false;
  const segment = (text: string) => text.length >= 32 && new Set(text).size >= 6;
  if (run.startsWith('/')) return false; // paths are handled segment by segment
  if (!run.includes('/')) return run.length >= 32;
  return /\d/.test(run) && /[A-Za-z]/.test(run) && (segment(run) || run.length >= 32);
}

function ipv6(candidate: string): boolean {
  const bare = candidate.replace(/%.*$/, '');
  if (!/[0-9a-f]/i.test(bare.replace(/:/g, ''))) return false;
  if (bare.includes('::')) return bare !== '::1';
  return bare.split(':').length === 8;
}

/** Any run of 16 or more characters of the token, wherever it sits in the text. */
function redactWindows(text: string, secret: string): string {
  let out = '';
  for (let i = 0; i < text.length;) {
    if (i + 16 <= text.length && secret.includes(text.slice(i, i + 16))) {
      let end = i + 16;
      while (end < text.length && secret.includes(text.slice(i, end + 1))) end += 1;
      out += '<redacted>';
      i = end;
    } else {
      out += text[i];
      i += 1;
    }
  }
  return out;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GIT_SHA = /^[0-9a-f]{40}$/i;

export function scrub(text: string, context: ScrubContext): string {
  // A percent-encoded path or address (%2F, %3A) is read as what it spells.
  let out = text.replace(/%(?:2F|5C|3A|40|3D)/gi, (code) => String.fromCharCode(parseInt(code.slice(1), 16)));
  // A token split across two lines leaves a piece; its first and last 12 characters catch it.
  const secrets = context.secrets.filter((value) => value.length >= 8).sort((a, b) => b.length - a.length);
  for (const secret of secrets) out = out.split(secret).join('<redacted>');
  for (const secret of secrets.filter((value) => value.length >= 24)) {
    const parts: string[] = [];
    for (let length = secret.length - 1; length >= 12; length -= 1) parts.push(escape(secret.slice(0, length)), escape(secret.slice(-length)));
    out = out.replace(new RegExp(parts.join('|'), 'g'), '<redacted>');
    out = redactWindows(out, secret);
  }
  if (context.home.length > 1) out = out.split(context.home).join('~');
  const names = [context.user, ...(context.users ?? [])].filter((value) => value.length > 0);
  // Home directories, whoever's; the root account's; and a known user's name as any path segment (a second volume's /<root>/<name>).
  out = out.replace(/(?:\/(?:home|Users)\/|[A-Za-z]:\\Users\\)[^/\\\s'"]+/gi, '~');
  out = out.replace(/(?<![\w.-])\/root(?=[/\s'"]|$)/g, '~');
  for (const name of names) out = out.replace(new RegExp(`(?<=[/\\\\])${escape(name)}(?=[/\\\\\\s'"]|$)`, 'gi'), '<user>');
  // Credentials in every common form.
  out = out.replace(/\b(Authorization\s*[:=]\s*["']?)(Basic|Bearer|token)\s+[^\s"',;]+/gi, '$1$2 <redacted>');
  out = out.replace(/\b(Bearer)\s+(?!<redacted>)[A-Za-z0-9._~+/=-]+/gi, '$1 <redacted>');
  out = out.replace(/\b((?:Set-)?Cookie\s*[:=]\s*)[^\r\n]+/gi, '$1<redacted>');
  out = out.replace(new RegExp(`(${KEY_NAME}["']?\\s*[:=]\\s*)("[^"]*"|'[^']*'|[^\\s"'&,;}]+)`, 'gi'), (whole, head: string, value: string) => {
    if (value.includes('<redacted>') || /^(?:Basic|Bearer|token)$/i.test(value)) return whole;
    const quote = value[0] === '"' || value[0] === "'" ? value[0] : '';
    return `${head}${quote}<redacted>${quote}`;
  });
  out = out.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '<redacted>');
  out = out.replace(/\bAKIA[0-9A-Z]{16}\b/g, '<redacted>');
  out = out.replace(/\b(?:sk|pk|rk|ghp|gho|ghs|ghu|ghr|xox[abprs])[-_][A-Za-z0-9_-]{8,}|\bgithub_pat_[A-Za-z0-9_]{8,}/g, '<redacted>');
  out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '<email>');
  out = out.replace(/\b[A-Za-z0-9._-]+@[A-Za-z0-9._-]+/g, '<user>@<host>');
  out = out.replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ts\.net\b/gi, '<host>');
  // Host names on label boundaries, longest first: a leading-label prefix of a
  // dotted name ("gpu-box.corp" of "gpu-box.corp.example.com") counts too. A
  // short name (the first label of a dotted name) also takes a "-word" tail.
  const dotted = context.hostnames.filter((value) => value.includes('.') && !/^[\d.]+$/.test(value) && !value.includes(':'));
  const shorts = new Set(dotted.map((value) => value.split('.')[0].toLowerCase()));
  const hosts = new Set(context.hostnames.filter((value) => value.length >= 2).map((value) => value.toLowerCase()));
  for (const name of dotted) {
    const labels = name.split('.');
    for (let count = 1; count < labels.length; count += 1) hosts.add(labels.slice(0, count).join('.').toLowerCase());
  }
  for (const name of [...hosts].sort((a, b) => b.length - a.length)) {
    const tail = shorts.has(name) && name.length >= 4 ? '(?:-\\w[\\w-]*)?' : '';
    out = out.replace(new RegExp(`(?<![\\w-])${escape(name)}${tail}(?![\\w-])`, 'gi'), '<host>');
  }
  out = out.replace(/(?<![\w.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![\w.]*\d)/g,
    (ip, offset: number) => (ip === '127.0.0.1' || ip === '0.0.0.0' || /(?:version|tmux|helper|\bv)\s*$/i.test(out.slice(Math.max(0, offset - 12), offset)) ? ip : '<ip>'));
  out = out.replace(/(?<![0-9A-Za-z:])[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}(?:%[\w.-]+)?(?![0-9A-Za-z])/gi,
    (candidate) => (ipv6(candidate) ? '<ip>' : candidate));
  // Long key-like strings. A path keeps its words: only its long segments go.
  out = out.replace(/[A-Za-z0-9+/_=-]{32,}/g, (run) => {
    if (UUID.test(run) || GIT_SHA.test(run)) return run;
    if (run.startsWith('/')) return run.replace(/[A-Za-z0-9+_=-]{32,}/g, (part) => (new Set(part).size >= 6 && !UUID.test(part) && !GIT_SHA.test(part) ? '<redacted>' : part));
    return keyLike(run) ? '<redacted>' : run;
  });
  for (const name of names.filter((value) => value.length >= 4 && !COMMON_USERS.has(value.toLowerCase()))) {
    out = out.replace(new RegExp(`(?<![\\w-])${escape(name)}(?:-\\w[\\w-]*)?(?![\\w-])`, 'gi'), '<user>');
  }
  return out;
}

export function environmentText(facts: IssueFacts): string {
  const system = ({ darwin: 'macOS', linux: 'Linux', win32: 'Windows' } as Record<string, string>)[facts.platform] ?? facts.platform;
  const tmux = facts.tmux?.version ? `${facts.tmux.bundled ? 'Dolphin’s tmux' : 'tmux'} ${facts.tmux.version}` : 'tmux unknown';
  return [
    `Dolphin ${facts.appVersion} (${facts.channel} channel)`,
    `${system} ${facts.osRelease}, ${facts.arch}`,
    `Helper ${facts.helperVersion ?? 'unknown'}, ${tmux}`,
    `Machines over SSH: ${facts.sshMachines}`,
  ].join('\n');
}

export function issueUrl(facts: IssueFacts, context: ScrubContext): string {
  const environment = scrub(environmentText(facts), context);
  let lines = facts.logLines.map((line) => scrub(line, context).slice(0, 300));
  for (;;) {
    const query = new URLSearchParams({ template: 'bug_report.yml', version: facts.appVersion, environment, logs: lines.join('\n') });
    const url = `${ISSUE_URL}?${query}`;
    if (url.length <= MAX_URL || lines.length === 0) return url;
    lines = lines.slice(Math.max(1, Math.floor(lines.length / 4)));
  }
}

/** The last `count` lines of a log, reading at most its final `maxBytes`. */
export function tailLines(file: string, count: number, maxBytes = 64 * 1024): string[] {
  let handle: number | undefined;
  try {
    handle = openSync(file, 'r');
    const size = fstatSync(handle).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    readSync(handle, buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n').filter((line) => line.trim() !== '');
    if (length < size) lines.shift(); // cut in half by the window
    return lines.slice(-count);
  } catch {
    return [];
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
}
