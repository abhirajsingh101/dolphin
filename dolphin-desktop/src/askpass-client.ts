/* Run by ssh as SSH_ASKPASS (through Electron in Node mode): sends the prompt
 * to the app and prints the user's answer. Exits non-zero on cancel, which
 * ssh treats as "no answer". */

import net from 'node:net';

const question = process.argv.slice(2).join(' ') || 'SSH';
const socket = net.connect(process.env.DOLPHIN_ASKPASS_SOCKET || '');
let reply = '';
socket.on('connect', () => socket.write(`${question.replace(/\n/g, ' ')}\n`));
socket.on('data', (chunk) => (reply += chunk.toString()));
socket.on('end', () => {
  if (reply === '\u0000' || reply === '') process.exit(1);
  process.stdout.write(reply);
  process.exit(0);
});
socket.on('error', () => process.exit(1));
