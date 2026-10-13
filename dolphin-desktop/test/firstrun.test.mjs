// The first-run checklist, against the real helper: what this machine has,
// and one click for each thing it lacks. HOME is scratch with a fake `claude`
// and a fake `npm` (so Codex is offered as an install); a fake curl fails
// every download (fakeGbrainDownloads), so turning memory on never fetches the real 400 MB; tmux gets a scratch TMUX_TMPDIR. The user's real agent settings are never touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fakeGbrainDownloads, launchApp, scratchEnv, tmuxFor, teardown } from './support.mjs';

const shots = process.env.DOLPHIN_SHOTS || tmpdir();

test('the checklist shows what is missing, and each click fixes one thing', { timeout: 240_000 }, async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'dfirst-'));
  const dolphinHome = path.join(home, '.dolphin-server');
  const fakeBin = path.join(home, 'fakebin');
  mkdirSync(fakeBin, { recursive: true });
  const script = (name, body) => { writeFileSync(path.join(fakeBin, name), `#!/bin/sh\n${body}\n`); chmodSync(path.join(fakeBin, name), 0o755); };
  script('claude', 'exit 0');
  script('npm', 'exit 0');
  fakeGbrainDownloads(dolphinHome);
  
  const env = scratchEnv(home, { DOLPHIN_GBRAIN: 'ask', DOLPHIN_TMUX_IMPORT: 'off', PATH: `${fakeBin}:/usr/bin:/bin` });
  for (const key of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME']) delete env[key];
  let app;
  try {
    app = await launchApp(home, env);
    const window = await app.firstWindow();
    await window.waitForURL(/desktop\.html/, { timeout: 90_000 });
    const list = window.getByRole('region', { name: 'Setup checklist' });
    await list.getByRole('button', { name: 'Turn on memory' }).waitFor({ timeout: 30_000 });
    assert.match(await list.innerText(), /tmux \d/);
    await list.getByRole('button', { name: 'Sign in to Claude Code' }).waitFor();
    await list.getByRole('button', { name: 'Install Codex' }).waitFor();
    await list.getByRole('button', { name: 'Turn on notifications' }).waitFor();
    await window.waitForTimeout(800); // the rows finish fading in
    await window.screenshot({ path: path.join(shots, 'desktop-first-run-checklist.png') });

    await list.getByRole('button', { name: 'Turn on notifications' }).click();
    await list.getByText('On for Claude Code.').waitFor({ timeout: 15_000 });
    assert.match(readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'), /dolphin-hook --provider claude --event stop/);

    await list.getByRole('button', { name: 'Turn on memory' }).click();
    await list.getByText(/Setup failed: Download failed/).waitFor({ timeout: 60_000 });
    assert.equal(JSON.parse(readFileSync(path.join(dolphinHome, 'gbrain', 'consent.json'), 'utf8')).memory, true);
    assert.equal(JSON.parse(readFileSync(path.join(home, 'profile', 'settings.json'), 'utf8')).memory, true);
    await list.getByRole('button', { name: 'Retry memory setup' }).waitFor();

    writeFileSync(path.join(home, '.claude', '.credentials.json'), '{"test": true}');
    await list.getByRole('button', { name: 'Check Again' }).click();
    await list.getByText('Installed and signed in.').waitFor({ timeout: 15_000 });
    await window.screenshot({ path: path.join(shots, 'desktop-first-run-checklist-done.png') });
  } finally {
    // Only this test's own tmux server, on its scratch socket.
    await teardown({ app, helpers: [dolphinHome], cleanup: [() => { try { tmuxFor(env)('kill-server'); } catch (error) { if (!/no server running|No such file|error connecting/.test(String(error.stderr ?? error.message))) throw error; } }], remove: [home] });
  }
});
