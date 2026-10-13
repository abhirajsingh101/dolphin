// What the main process says when an agent finishes a turn, and the stream it
// listens to. Pure modules and a local HTTP server; no Electron, no helper.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { feedChanges, HeldPopups, isOpenTarget, notificationContent, SeenIds, wantsSystemNotification } from '../dist/notify.js';
import { openFeed, sseParser } from '../dist/feed.js';

const item = { id: 'n1', kind: 'turn_end', provider: 'claude', project_id: 'demo', project_name: 'demo', session_name: 'build', summary: 'Ported the homepage.', read: false };

test('a notification is titled session · project; another machine is named only when remote', () => {
  assert.deepEqual(notificationContent(item, null, 'linux'), { title: 'build · demo', body: 'Ported the homepage.' });
  assert.deepEqual(notificationContent(item, 'gpu-box', 'linux'), { title: 'build · demo · gpu-box', body: 'Ported the homepage.' });
  assert.deepEqual(notificationContent(item, 'gpu-box', 'darwin'), { title: 'build · demo', body: 'Ported the homepage.', subtitle: 'gpu-box' });
  assert.equal(notificationContent({ ...item, project_name: null }, null, 'linux').title, 'build · No project');
});

test('an empty summary still says who finished', () => {
  assert.equal(notificationContent({ ...item, summary: ' ' }, null, 'linux').body, 'Claude Code finished its turn.');
  assert.equal(notificationContent({ ...item, summary: '', provider: 'codex' }, null, 'linux').body, 'Codex finished its turn.');
});

test('system notifications only while the window is not focused, and only when on', () => {
  assert.equal(wantsSystemNotification({ enabled: true, windowFocused: false }), true);
  assert.equal(wantsSystemNotification({ enabled: true, windowFocused: true }), false);
  assert.equal(wantsSystemNotification({ enabled: false, windowFocused: false }), false);
});

test('only a complete target opens a session', () => {
  assert.equal(isOpenTarget({ machine: 'local', projectId: 'p', session: 's' }), true);
  assert.equal(isOpenTarget({ machine: 'local', projectId: 'p' }), false);
  assert.equal(isOpenTarget({ machine: 'local', projectId: 'p', session: 7 }), false);
  assert.equal(isOpenTarget(null), false);
});

test('feeds restart when a machine’s address or token changes, and stop when it goes', () => {
  const { stop, start } = feedChanges(new Map([['local', 'a t'], ['gpu', 'b t']]), new Map([['local', 'a t'], ['gpu', 'c t'], ['mac', 'd t']]));
  assert.deepEqual(stop, ['gpu']);
  assert.deepEqual(start, ['gpu', 'mac']);
  assert.deepEqual(feedChanges(new Map([['gpu', 'b t']]), new Map()), { stop: ['gpu'], start: [] });
});

test('a turn is announced once even if a reconnect delivers it again', () => {
  const seen = new SeenIds(2);
  assert.equal(seen.add('local n1'), true);
  assert.equal(seen.add('local n1'), false);
  seen.add('a');
  seen.add('b');
  assert.equal(seen.add('local n1'), true); // forgotten after `limit` newer ids
});

test('the SSE parser joins split chunks, multi-line data, and skips comments', () => {
  const events = [];
  const feed = sseParser((event, data) => events.push([event, data]));
  feed(': connected\n\nevent: notif');
  feed('ication\ndata: {"a":\ndata: 1}\n\n');
  feed('data: plain\r\n\r\n');
  assert.deepEqual(events, [['notification', '{"a":\n1}'], ['message', 'plain']]);
});

test('a feed sends the token, reports unread notifications, and reconnects after a drop', async () => {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({ token: request.headers['x-dolphin-token'], accept: request.headers.accept });
    const fresh = JSON.stringify({ ...item, id: `n${requests.length}` });
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write(`: connected\n\nevent: notification\ndata: ${fresh.slice(0, 20)}`);
    response.end(`${fresh.slice(20)}\n\nevent: notification\ndata: ${JSON.stringify({ ...item, id: 'old', read: true })}\n\nevent: turn\ndata: {}\n\n`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const got = [];
  const feed = openFeed({ url: `http://127.0.0.1:${server.address().port}/api/notifications/stream`, token: 'tok', retryMs: 20, onNotification: (n) => got.push(n.id) });
  try {
    for (let i = 0; i < 200 && got.length < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(got.slice(0, 2), ['n1', 'n2']);
    assert.equal(requests[0].token, 'tok');
    assert.match(requests[0].accept, /text\/event-stream/);
  } finally {
    feed.stop();
  }
  const count = requests.length;
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(requests.length, count); // stopped: no more reconnects
  await new Promise((resolve) => server.close(resolve));
});

const listen = async (handler) => {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/s`, close: () => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); } };
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (check) => { for (let i = 0; i < 300 && !check(); i += 1) await sleep(10); };

test('the SSE parser survives a CRLF split across chunks', () => {
  const events = [];
  const feed = sseParser((event, data) => events.push([event, data]));
  feed('data: a\r');
  feed('\n\r');
  feed('\n');
  assert.deepEqual(events, [['message', 'a']]);
});

test('a silent half-open stream is dropped after the idle limit and reconnected', async () => {
  const times = [];
  const s = await listen((request, response) => {
    times.push(Date.now());
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write(': ping\n\n'); // then silence, connection left open
  });
  const feed = openFeed({ url: s.url, token: 't', retryMs: 10, idleMs: 100, onNotification: () => {} });
  try {
    await until(() => times.length >= 2);
    assert.ok(times.length >= 2, 'a second request after the idle limit');
    assert.ok(times[1] - times[0] >= 90, 'not before the idle limit');
  } finally {
    feed.stop();
    await s.close();
  }
});

test('retries back off, capped, and reset after a connection that delivered data', async () => {
  const times = [];
  const s = await listen((request, response) => {
    times.push(Date.now());
    if (times.length === 3) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end(': hello\n\n');
    } else {
      response.writeHead(500);
      response.end();
    }
  });
  const feed = openFeed({ url: s.url, token: 't', retryMs: 40, maxRetryMs: 160, onNotification: () => {} });
  try {
    await until(() => times.length >= 5);
    const gaps = times.slice(1).map((t, i) => t - times[i]);
    assert.ok(gaps[0] >= 35, `first gap ${gaps[0]}`);
    assert.ok(gaps[1] >= 75, `second gap doubles: ${gaps[1]}`);
    assert.ok(gaps[2] < 100, `reset after data (would be 160): ${gaps[2]}`);
  } finally {
    feed.stop();
    await s.close();
  }
});

test('stop() mid-stream aborts the request', async () => {
  let closed = false;
  let opened = 0;
  const s = await listen((request, response) => {
    opened += 1;
    request.on('close', () => { closed = true; });
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write(': hi\n\n');
  });
  const feed = openFeed({ url: s.url, token: 't', retryMs: 10, onNotification: () => {} });
  await until(() => opened > 0);
  feed.stop();
  await until(() => closed);
  assert.equal(closed, true);
  await sleep(60);
  assert.equal(opened, 1);
  await s.close();
});

test('a multi-byte character split across chunks arrives whole', async () => {
  const got = [];
  const s = await listen((request, response) => {
    const bytes = Buffer.from(`event: notification\ndata: ${JSON.stringify({ ...item, summary: 'costs 5€ ok' })}\n\n`);
    const cut = bytes.indexOf(0xe2) + 1; // inside the euro sign
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write(bytes.subarray(0, cut));
    setTimeout(() => response.write(bytes.subarray(cut)), 30);
  });
  const feed = openFeed({ url: s.url, token: 't', retryMs: 1000, onNotification: (n) => got.push(n.summary) });
  try {
    await until(() => got.length > 0);
    assert.deepEqual(got, ['costs 5€ ok']);
  } finally {
    feed.stop();
    await s.close();
  }
});

test('held notifications are released on click or close, after the timeout, and past the cap', () => {
  const pending = new Map();
  let next = 0;
  const timers = { set: (run) => { pending.set(++next, run); return next; }, clear: (id) => pending.delete(id) };
  const held = new HeldPopups(3, 1000, timers);
  held.hold('a'); held.hold('b');
  assert.equal(held.size, 2);
  held.release('a');
  assert.equal(held.size, 1);
  assert.equal(pending.size, 1, 'a released popup clears its timer');
  for (const run of [...pending.values()]) run();
  assert.equal(held.size, 0, 'the timeout releases one that never closed');
  for (const id of ['c', 'd', 'e', 'f']) held.hold(id);
  assert.equal(held.size, 3, 'past the cap the oldest goes');
  assert.equal(pending.size, 3);
  held.release('c');
  assert.equal(held.size, 3, 'c was already dropped');
});
