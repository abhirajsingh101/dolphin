import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { contentSecurityPolicy, inlineScriptHashes } from '../dist/csp.js';

test('inline scripts are allowed by their hash, external ones by origin', () => {
  const html = '<script src="./theme-init.js"></script><script>window.setStatus = () => 1;</script>';
  const digest = createHash('sha256').update('window.setStatus = () => 1;').digest('base64');
  assert.deepEqual(inlineScriptHashes(html), [`'sha256-${digest}'`]);
  const policy = contentSecurityPolicy(html);
  assert.ok(policy.includes(`script-src 'self' 'sha256-${digest}'`), policy);
  assert.doesNotMatch(policy, /script-src[^;]*'unsafe-(inline|eval)'/);
});

test('the policy lets the page reach helpers on loopback, and nothing else', () => {
  const policy = contentSecurityPolicy('');
  assert.match(policy, /connect-src 'self' http:\/\/127\.0\.0\.1:\* ws:\/\/127\.0\.0\.1:\*/);
  assert.match(policy, /object-src 'none'/);
  assert.match(policy, /base-uri 'none'/);
  assert.match(policy, /frame-ancestors 'none'/);
});
