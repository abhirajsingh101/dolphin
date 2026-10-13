// A helper that accepts a connection but never answers must not hang Dolphin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { healthOnce, waitHealthy } from '../dist/health.js';

async function serve(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => { server.closeAllConnections(); server.close(); } };
}

test('waitHealthy gives up at its deadline even when no request ever answers', { timeout: 10_000 }, async () => {
  const silent = await serve(() => { /* never answers */ });
  try {
    const started = Date.now();
    await assert.rejects(waitHealthy(silent.url, 1_000, { fetchTimeoutMs: 200, pollMs: 50 }), /did not answer \(no answer within \d+ ms\)/);
    assert.ok(Date.now() - started < 2_500, `took ${Date.now() - started} ms`);
  } finally {
    silent.close();
  }
});

test('healthOnce: true when /health answers, false when it does not in time', { timeout: 10_000 }, async () => {
  const healthy = await serve((request, response) => { response.statusCode = request.url === '/health' ? 200 : 404; response.end('{}'); });
  const silent = await serve(() => { /* never answers */ });
  try {
    assert.equal(await healthOnce(healthy.url, 1_000), true);
    const started = Date.now();
    assert.equal(await healthOnce(silent.url, 200), false);
    assert.ok(Date.now() - started < 1_500);
    assert.equal(await healthOnce('http://127.0.0.1:9', 500), false);
  } finally {
    healthy.close();
    silent.close();
  }
});

test('waitHealthy reports the HTTP status when /health answers non-ok until the deadline', { timeout: 10_000 }, async () => {
  const broken = await serve((request, response) => { response.statusCode = 500; response.end('{}'); });
  try {
    await assert.rejects(waitHealthy(broken.url, 500, { fetchTimeoutMs: 200, pollMs: 50 }), /did not answer \(HTTP 500\)/);
    assert.equal(await healthOnce(broken.url, 500), false);
  } finally {
    broken.close();
  }
});
