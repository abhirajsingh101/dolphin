# Dolphin

![Dolphin: a project's terminal, the first-run checklist and System Health](https://github.com/abhirajsingh101/dolphin/releases/download/desktop-v0.2.5/dolphin-hero.gif)

Dolphin is a desktop workspace for running coding agents in real terminals, on
your own computer or on any machine you can reach over SSH.

Each project gets its own tmux sessions running Claude Code, Codex or a plain
shell. Sessions keep running when you close the app, and Dolphin tells you when
an agent finishes a turn. A built-in System Health view shows what the machine
is doing.

## Download

Dolphin 0.2.5. Every release is on
[Releases](https://github.com/abhirajsingh101/dolphin/releases).

| Platform | Download |
|---|---|
| macOS, Apple Silicon | [Dolphin-0.2.5-mac-arm64.dmg](https://github.com/abhirajsingh101/dolphin/releases/download/desktop-v0.2.5/Dolphin-0.2.5-mac-arm64.dmg) |
| macOS, Intel | [Dolphin-0.2.5-mac-x64.dmg](https://github.com/abhirajsingh101/dolphin/releases/download/desktop-v0.2.5/Dolphin-0.2.5-mac-x64.dmg) |
| Linux x64, AppImage (updates itself) | [Dolphin-0.2.5-linux-x86_64.AppImage](https://github.com/abhirajsingh101/dolphin/releases/download/desktop-v0.2.5/Dolphin-0.2.5-linux-x86_64.AppImage) |
| Linux x64, Debian and Ubuntu | [Dolphin-0.2.5-linux-amd64.deb](https://github.com/abhirajsingh101/dolphin/releases/download/desktop-v0.2.5/Dolphin-0.2.5-linux-amd64.deb) |
| Linux x64, Fedora and RHEL | [Dolphin-0.2.5-linux-x86_64.rpm](https://github.com/abhirajsingh101/dolphin/releases/download/desktop-v0.2.5/Dolphin-0.2.5-linux-x86_64.rpm) |
| Linux arm64, AppImage (updates itself) | [Dolphin-0.2.5-linux-arm64.AppImage](https://github.com/abhirajsingh101/dolphin/releases/download/desktop-v0.2.5/Dolphin-0.2.5-linux-arm64.AppImage) |
| Linux arm64, Debian and Ubuntu | [Dolphin-0.2.5-linux-arm64.deb](https://github.com/abhirajsingh101/dolphin/releases/download/desktop-v0.2.5/Dolphin-0.2.5-linux-arm64.deb) |
| Linux arm64, Fedora and RHEL | [Dolphin-0.2.5-linux-aarch64.rpm](https://github.com/abhirajsingh101/dolphin/releases/download/desktop-v0.2.5/Dolphin-0.2.5-linux-aarch64.rpm) |

On a Mac with Homebrew, once the tap is published:

```bash
brew install --cask abhirajsingh101/dolphin/dolphin-desktop
```

The Homebrew tap is not published yet, so this command does not work until it
is. Until then, use the downloads above.

### Opening Dolphin on macOS the first time

macOS builds are not signed yet, so macOS blocks Dolphin the first time you
open it:

1. Open Dolphin from Applications. macOS says it could not verify Dolphin;
   choose Done.
2. Open System Settings, then Privacy & Security. Under Security, choose
   Open Anyway next to the message about Dolphin.
3. Confirm with your password or Touch ID, then choose Open.

You do this once. From a terminal, `xattr -dr com.apple.quarantine /Applications/Dolphin.app`
does the same.

## Features

- **First run:** a checklist shows what this machine has (tmux, Claude Code,
  Codex, whether each is signed in, notifications, memory) and offers one
  click for each thing it lacks, then lists your recent repositories to open.
- **Projects and terminals:** open a folder, then start Claude Code, Codex or a
  shell in it. Every session is a real tmux session, so it outlives the app and
  your network connection. A session can start in a new git worktree, and
  Review Changes shows what an agent changed.
- **This computer or SSH:** choose Connect to a Machine. Dolphin lists the
  machines it finds on this computer (your SSH config, the servers you ssh
  into, your Tailscale devices), or you type `user@host`. It installs a small
  helper there on first connect, over your existing SSH access, then stays
  connected: after a network change or sleep it reconnects by itself, and the
  machine opens again the next time you start Dolphin. Passwords, key
  passphrases and host-key prompts appear in the app. SSH agent forwarding can
  be turned on per machine.
- **Other sessions:** tmux sessions already running on a machine outside your
  projects are listed, and can be opened.
- **History:** the history button on a project searches its Claude and Codex
  transcripts, and Resume in new session continues one.
- **Usage:** Usage in a connected machine's menu shows the Claude Code and Codex tokens used on it, from the agents' own logs.
- **Ports:** lists the ports a machine is listening on.
- **Agent setup:** if Claude Code or Codex is missing, Dolphin offers to install
  it in a terminal you can watch. Nothing installs without your click.
- **Notifications:** one click gives Claude Code and Codex Dolphin's turn
  notifications, so you hear when an agent finishes.
- **Chat:** ask Dolphin about your projects and sessions, or have it start work
  in a new agent session. It runs on your installed Claude Code or Codex.
- **Memory (optional, off by default):** turn it on in the first-run checklist
  or in Settings, and each machine gets its own
  [GBrain](https://github.com/garrytan/gbrain). Tell the chat to remember
  something and it recalls it later, and your agents can share it. It runs
  keyless (keyword search, no API costs) and keeps everything in
  `~/.dolphin-server/gbrain`. Setting it up downloads Bun and a pinned GBrain
  release, about 400 MB, checksum-verified. Nothing is downloaded until you
  turn it on.
- **Tasks:** a simple task list per project.
- **System Health:** CPU, memory, disks, network, GPUs and the busiest
  processes, from netdata when it is running and a built-in monitor otherwise.

## Requirements

- macOS 11 or later (Apple Silicon or Intel), or Linux (x64 or arm64).
  SSH machines can be Linux x64 or arm64, or macOS.
- For agents: [Claude Code](https://docs.claude.com/en/docs/claude-code) and/or
  [Codex](https://github.com/openai/codex). Dolphin can install either for you
  (Codex needs npm or Homebrew).
- tmux 3.0 or later is used when present. Otherwise Dolphin uses its own bundled
  tmux, on a separate socket, without touching your system.

## Updates

Dolphin checks for a new release quietly: when it starts, every hour, and
when your computer wakes. When there is one, an Update pill appears in the
header. To check yourself, click the Dolphin logo: the About panel shows your
version, when Dolphin last checked, and a Check for Updates button.

- **AppImage:** the update downloads in the background; choose Restart to
  Update when it suits you, or it installs the next time you quit.
- **macOS, .deb and .rpm:** Dolphin tells you a new version is out and opens the
  right installer. macOS cannot update an unsigned app in place yet.
- **Beta:** choose the Beta update channel in Settings to get prereleases
  too. Switching back to Stable drops an offered beta and never downgrades;
  you get the next stable release that is newer than the one you run.

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

## Reporting a problem

Choose Help, then Report an Issue. Dolphin opens a GitHub issue in your browser
with the Dolphin version, your system and the last lines of the helper log
already filled in. Before that, it removes from them:

- your home folder and user name, and the user names of your SSH machines;
- this computer's host name, and each SSH machine's host name, short name, alias
  and the name SSH resolves it to;
- IPv4 and IPv6 addresses and email addresses;
- the helper tokens, passwords, cookies, API keys, bearer and JWT tokens, and
  other long key-like strings.

This is pattern matching, so read the issue and edit out anything it missed.
Nothing is sent until you press Submit on GitHub.

Crash reports stay on this computer under Help → Show Crash Reports, are never sent anywhere, and can be turned off in Settings.

## Build from source

See [docs/development.md](docs/development.md).

## License

MIT. The bundled tmux, libevent and utf8proc keep their own licenses, which ship
beside them in the app. GBrain (MIT) and Bun (MIT) are downloaded only when you turn memory on.
