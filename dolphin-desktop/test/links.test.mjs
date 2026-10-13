import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLoopbackHost, openableExternally } from '../dist/links.js';

const own = new Set([43123]);

test('web and loopback links open in the browser', () => {
  assert.equal(openableExternally('https://example.com/docs', own), true);
  assert.equal(openableExternally('http://localhost:3000/', own), true);
  assert.equal(openableExternally('http://127.0.0.1:5173/app', own), true);
  assert.equal(openableExternally('http://[::1]:8080/', own), true);
});

test("Dolphin's own helper ports and other schemes never do", () => {
  assert.equal(openableExternally('http://127.0.0.1:43123/api/projects?token=x', own), false);
  assert.equal(openableExternally('http://localhost:43123/', own), false);
  assert.equal(openableExternally('http://[::1]:43123/', own), false);
  assert.equal(openableExternally('file:///etc/passwd', own), false);
  assert.equal(openableExternally('javascript:alert(1)', own), false);
  assert.equal(openableExternally('not a url', own), false);
});

test('isLoopbackHost names the hosts that mean this computer', () => {
  for (const host of ['localhost', 'LOCALHOST', '127.0.0.1', '127.1.2.3', '[::1]']) assert.equal(isLoopbackHost(host), true, host);
  for (const host of ['example.com', '10.0.0.1', '127.0.0.1.evil.com', '']) assert.equal(isLoopbackHost(host), false, host);
});

test('every spelling of this computer is refused on a Dolphin port', () => {
  for (const url of [
    'http://0.0.0.0:43123/', 'http://0:43123/', 'http://localhost.:43123/', 'http://[::ffff:127.0.0.1]:43123/',
    'http://[::]:43123/', 'http://foo.localhost:43123/', 'http://LOCALHOST:43123/', 'http://x@127.0.0.1:43123/',
    'http://0x7f.1:43123/', 'http://2130706433:43123/', 'http://127.1.2.3:43123/', 'http://10.0.0.5:43123/',
    'http://intranet:43123/', 'https://127.0.0.1:43123/',
  ]) assert.equal(openableExternally(url, own), false, url);
});

test('the same hosts on other ports, and public hosts on any port, still open', () => {
  assert.equal(openableExternally('http://0.0.0.0:3000/', own), true);
  assert.equal(openableExternally('http://foo.localhost:3000/', own), true);
  assert.equal(openableExternally('http://localhost.:3000/', own), true);
  assert.equal(openableExternally('https://example.com:8443/', own), true);
  assert.equal(openableExternally('https://example.com:43123/', own), true);
  assert.equal(openableExternally('https://Example.COM./x', own), true);
});

test('isLoopbackHost covers trailing dots, *.localhost, 0.0.0.0 and mapped IPv6', () => {
  for (const host of ['localhost.', 'foo.localhost', 'a.b.localhost.', '0.0.0.0', '[::]', '[::ffff:7f00:1]', '[::ffff:127.0.0.1]', '127.255.0.1']) assert.equal(isLoopbackHost(host), true, host);
  for (const host of ['notlocalhost', 'localhost.evil.com', '[2001:db8::1]', '[::ffff:808:808]']) assert.equal(isLoopbackHost(host), false, host);
});
