/* SSH prompts inside the app: passwords, key passphrases, 2FA codes and the
 * first-connection host-key question.
 *
 * OpenSSH runs SSH_ASKPASS for every prompt when SSH_ASKPASS_REQUIRE=force.
 * Ours is a two-line shell script that runs this same Electron binary as Node
 * (askpass-client.js), which sends the prompt over a private Unix socket to
 * the main process and prints the answer. The main process shows a modal
 * dialog. Nothing is stored; each answer goes straight back to ssh. */

import { app, BrowserWindow, ipcMain } from 'electron';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

let socketPath = '';
let scriptPath = '';

type Pending = { resolve: (answer: string | null) => void };
const pending = new Map<string, Pending>();

/** Ask the user in a small modal window. Null means they cancelled. */
function prompt(question: string): Promise<string | null> {
  return new Promise((resolve) => {
    const id = randomBytes(8).toString('hex');
    const confirm = /\(yes\/no(\/\[fingerprint\])?\)\?/i.test(question);
    const secret = !confirm && /password|passphrase|pin|code|token|verification/i.test(question);
    const window = new BrowserWindow({
      width: 460, height: confirm ? 360 : 240, resizable: false, minimizable: false, maximizable: false,
      alwaysOnTop: true, title: 'Dolphin — SSH',
      webPreferences: { preload: path.join(__dirname, 'askpass-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    pending.set(id, { resolve: (answer) => { pending.delete(id); resolve(answer); } });
    window.on('closed', () => pending.get(id)?.resolve(null));
    const query = new URLSearchParams({ id, question, mode: confirm ? 'confirm' : secret ? 'secret' : 'text' });
    void window.loadURL(`app://connect/askpass.html?${query}`);
  });
}

ipcMain.on('dolphin:askpass-answer', (event, id: unknown, answer: unknown) => {
  if (typeof id !== 'string') return;
  pending.get(id)?.resolve(typeof answer === 'string' ? answer : null);
  BrowserWindow.fromWebContents(event.sender)?.close();
});

/** Start the prompt socket and write the askpass script. Returns the env for ssh. */
export function startAskpass(): NodeJS.ProcessEnv {
  if (!socketPath) {
    const dir = path.join(os.tmpdir(), `dolphin-askpass-${process.getuid?.() ?? 'u'}-${process.pid}`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    socketPath = path.join(dir, 's');
    rmSync(socketPath, { force: true });
    const server = net.createServer((connection) => {
      let text = '';
      connection.on('data', (chunk) => {
        text += chunk.toString();
        if (!text.includes('\n')) return;
        const question = text.split('\n')[0].slice(0, 2000);
        void prompt(question).then((answer) => connection.end(answer === null ? '\u0000' : `${answer}\n`));
      });
      connection.on('error', () => undefined);
    });
    server.listen(socketPath, () => chmodSync(socketPath, 0o600));
    scriptPath = path.join(dir, 'askpass');
    const client = path.join(__dirname, 'askpass-client.js');
    writeFileSync(scriptPath, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${process.execPath}" "${client}" "$@"\n`, { mode: 0o700 });
    app.on('will-quit', () => {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    });
  }
  return {
    SSH_ASKPASS: scriptPath,
    SSH_ASKPASS_REQUIRE: 'force',
    DISPLAY: process.env.DISPLAY || ':0', // older OpenSSH only consults askpass with a DISPLAY set
    DOLPHIN_ASKPASS_SOCKET: socketPath,
  };
}
