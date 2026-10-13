// The app's pages carry a CSP: injected inline script does not run, while the
// static pages' own inline scripts still do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchApp, scratchEnv, teardown } from './support.mjs';

test('app pages carry a Content Security Policy', { timeout: 120_000 }, async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'dcsp-'));
  const env = scratchEnv(home, { DOLPHIN_TMUX_IMPORT: 'off' });
  let app;
  try {
    app = await launchApp(home, env);
    const window = await app.firstWindow();
    const violations = [];
    window.on('console', (message) => { if (/Content Security Policy|Refused to/.test(message.text())) violations.push(message.text()); });
    await window.waitForURL(/desktop\.html/, { timeout: 90_000 });
    await window.getByRole('textbox', { name: 'Message Dolphin' }).waitFor({ timeout: 30_000 });
    const policy = await window.evaluate(async () => (await fetch(location.href)).headers.get('content-security-policy'));
    assert.match(policy ?? '', /script-src 'self'/);
    const ran = await window.evaluate(() => {
      const script = document.createElement('script');
      script.textContent = 'window.__inlineRan = true';
      document.head.append(script);
      return Boolean(window.__inlineRan);
    });
    assert.equal(ran, false, 'injected inline script must not run');
    assert.deepEqual(violations.filter((text) => !/inline script/i.test(text)), [], 'the workspace page itself breaks no CSP rule');
    const statusPage = await app.evaluate(async ({ BrowserWindow }) => {
      const probe = new BrowserWindow({ show: false });
      await probe.loadURL('app://connect/status.html#Testing');
      const kind = await probe.webContents.executeJavaScript('typeof window.setStatus');
      probe.destroy();
      return kind;
    });
    assert.equal(statusPage, 'function', "the launch page's own inline script still runs");
  } finally {
    await teardown({ app, helpers: [[env.DOLPHIN_HOME, { env }]], remove: [home] });
  }
});

test('redirects and frames cannot leave app:// either', { timeout: 120_000 }, async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'dcsp-'));
  const env = scratchEnv(home, { DOLPHIN_TMUX_IMPORT: 'off' });
  let app;
  try {
    app = await launchApp(home, env);
    const window = await app.firstWindow();
    await window.waitForURL(/desktop\.html/, { timeout: 90_000 });
    const events = await app.evaluate(async ({ BrowserWindow }) => {
      const target = BrowserWindow.getAllWindows()[0].webContents;
      const prevented = (name, url) => {
        const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, url };
        target.emit(name, event, url);
        return event.defaultPrevented;
      };
      return [
        ...['will-navigate', 'will-redirect', 'will-frame-navigate'].map((name) => [name, prevented(name, 'https://example.com/')]),
        ['userinfo frame', prevented('will-frame-navigate', 'http://127.0.0.1:80@evil.com/')],
        ['loopback frame', prevented('will-frame-navigate', 'http://127.0.0.1:3000/')],
        ['bad url frame', prevented('will-frame-navigate', 'not a url')],
      ];
    });
    assert.deepEqual(events, [['will-navigate', true], ['will-redirect', true], ['will-frame-navigate', true], ['userinfo frame', true], ['loopback frame', false], ['bad url frame', true]]);
  } finally {
    await teardown({ app, helpers: [[env.DOLPHIN_HOME, { env }]], remove: [home] });
  }
});
