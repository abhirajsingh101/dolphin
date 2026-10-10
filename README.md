# Dolphin

Dolphin is a desktop workspace for running coding agents in real terminals, on
your own computer or on any machine you can reach over SSH.

Each project gets its own tmux sessions running Claude Code, Codex or a plain
shell. Sessions keep running when you close the app, and Dolphin tells you when
an agent finishes a turn. A built-in System Health view shows what the machine
is doing.

## Features

- **Projects and terminals:** open a folder, then start Claude Code, Codex or a
  shell in it. Every session is a real tmux session, so it outlives the app and
  your network connection.
- **This computer or SSH:** click the machine name next to the Dolphin logo
  and choose Connect to a Machine. Dolphin lists the machines it finds on this
  computer (your SSH config and the servers you ssh into), or you type
  `user@host`. It installs a small helper there on first connect,
  over your existing SSH access, then stays connected: after a network change
  or sleep it reconnects by itself, and the machine opens again the next time
  you start Dolphin. Passwords, key passphrases and host-key prompts appear in
  the app, and a machine that asked for a password can be set up to skip it.
- **Agent setup:** if Claude Code or Codex is missing, New Session offers to
  install it in a terminal you can watch. Nothing installs without your click.
- **Connect your agents:** one click gives Claude Code and Codex Dolphin's
  turn notifications (the bell tells you when one finishes) and its memory, so
  what you tell Dolphin reaches the agents doing the work.
- **Chat:** ask Dolphin about your projects and sessions, or have it start work
  in a new agent session. It runs on your installed Claude Code or Codex.
- **Memory:** every machine gets its own [GBrain](https://github.com/garrytan/gbrain),
  set up automatically on first start. Tell the chat to remember something and
  it recalls it in later conversations. It runs keyless (keyword search, no API
  costs) and keeps everything in `~/.dolphin-server/gbrain`.
- **Tasks:** a simple task list per project.
- **System Health:** CPU, memory, disks, network, GPUs and the busiest
  processes, from netdata when it is running and a built-in monitor otherwise.

## Requirements

- Linux (x64) or macOS 11 or later (Apple Silicon or Intel). SSH machines can
  also be Linux arm64 (Graviton, Ampere, Raspberry Pi).
- For agents: [Claude Code](https://docs.claude.com/en/docs/claude-code) and/or
  [Codex](https://github.com/openai/codex). Dolphin can install either for you
  (Codex needs npm or Homebrew).
- tmux 3.0 or later is used when present. Otherwise Dolphin uses its own bundled
  tmux, on a separate socket, without touching your system.

## Install

Download the installer for your platform from
[Releases](https://github.com/abhirajsingh101/dolphin/releases): an AppImage or
`.deb` for Linux, a `.dmg` for macOS.

macOS builds are not signed yet. On first open, right-click Dolphin in
Applications and choose Open.

## Updates

Dolphin checks for a new release quietly: when it starts, every hour, and
when your computer wakes. When there is one, an Update pill appears in the
header. To check yourself, click the Dolphin logo (or press ⌘K and choose
Check for Updates): the About panel shows your version, when Dolphin last
checked, and a Check for Updates button.

- **AppImage:** the update downloads in the background; choose Restart to
  Update when it suits you, or it installs the next time you quit. Your
  terminal sessions keep running.
- **macOS and .deb:** Dolphin tells you a new version is out and opens the
  right installer. macOS cannot update an unsigned app in place yet.

Your terminals keep running through an update: they belong to tmux, and the new
helper simply takes over from the old one, here and on your SSH machines.

## How it works

The app starts a small helper process on the machine it is working with. The
helper owns that machine's projects, tasks and tmux sessions and serves the
workspace over a private Unix socket (0600, readable only by you). Every request
must carry a random token stored in `~/.dolphin-server/token`. For SSH machines
the app forwards a loopback port to that socket through your SSH connection, so
nothing listens beyond loopback.

Dolphin has no account, no cloud service of its own and no telemetry. Its data
lives in `~/.dolphin-server` on each machine. Claude Code and Codex, including
the ones the chat runs on, talk to their providers as they do when you run them
yourself.

First start also sets up memory: Dolphin downloads Bun and a pinned GBrain
release (about 400 MB on disk, checksum-verified) and creates a local brain in
`~/.dolphin-server/gbrain`. It takes about 20 seconds; a line above the chat
shows progress and offers a retry if the download fails.

## Build from source

See [docs/development.md](docs/development.md).

## License

MIT. The bundled tmux, libevent and utf8proc keep their own licenses, which ship
beside them in the app. GBrain (MIT) and Bun (MIT) are downloaded at setup.
