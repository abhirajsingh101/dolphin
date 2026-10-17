# Security

## Reporting a vulnerability

Please report security problems privately, through
[GitHub's private vulnerability reporting](https://github.com/abhirajsingh101/dolphin/security/advisories/new).
Do not open a public issue for them.

Say what an attacker can do, what they need first, and how to reproduce it.
You will get an answer within a week. A fix ships in a new release, and the
advisory is published once installed apps can update to it.

Only the latest release is supported. Dolphin updates itself, so a fix
reaches users through the normal update.

## What Dolphin protects

A Dolphin terminal can run any command as you, so anything that can talk to
Dolphin's helper can too. The design keeps the helper reachable only by you:

- **A private socket.** On each machine the helper listens on a Unix socket in
  `~/.dolphin-server/run/`, readable and writable only by your user (0600).
  It does not listen on a network port.
- **A token on every request.** The helper creates a random token in
  `~/.dolphin-server/token` (0600). Every request and WebSocket must carry
  it, so another local program has to be able to read your files to get in.
- **Loopback only.** The app reaches the socket through a port it opens on
  127.0.0.1. For an SSH machine, the port is forwarded through your own SSH
  connection; nothing new is opened on the remote machine's network.
- **Requests from web pages are refused.** The helper accepts only loopback
  host names and the app's own origin, so a web page cannot reach it by
  pointing its own name at 127.0.0.1 (DNS rebinding).
- **Your SSH stays yours.** Dolphin uses your SSH config, keys and agent.
  Passwords and passphrases are passed to `ssh` when it asks for them and are
  never stored. Agent forwarding is off unless you turn it on per machine.
- **Nothing leaves your machines.** Dolphin has no account, no server of its
  own and no telemetry. Claude Code and Codex, including the ones the chat and
  memory use, talk to their providers as they do when you run them yourself.
- **Downloads are pinned.** Memory downloads nothing until you turn it on;
  then its components (Bun, GBrain, llama.cpp and the search model) are
  checked against pinned checksums before they are used.

## In scope

- Reaching the helper, or running commands through it, without the token.
- Reading another user's Dolphin data on a shared machine.
- A web page, link or file that makes Dolphin run a command or change data.
- An update that installs something other than a published Dolphin release.
- Secrets that reach issue reports, logs or memory despite the scrubbing
  described in the README.

## Out of scope

- Anything that already runs as your user on your machine: it can read the
  token and drive your terminals the same way you can.
- Commands that you, or an agent you started, run in a Dolphin terminal.
- The macOS warning about an unsigned app. The Mac builds are not signed yet.
