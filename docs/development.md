# Developing Dolphin

The repository has three parts:

| Folder | What |
|---|---|
| `dolphin-desktop/` | The Electron app: windows, hosts (local and SSH), askpass, packaging |
| `dolphin-backend/` | The helper: a FastAPI app with SQLite, tmux and System Health |
| `dolphin-web/` | The workspace UI (React, Vite, xterm.js) that the app loads |

## Set up

You need Python 3.12, Node.js 22 and tmux.

```bash
python3.12 -m venv dolphin-backend/venv
dolphin-backend/venv/bin/pip install -r dolphin-backend/requirements-dev.txt
npm ci --prefix dolphin-web
npm ci --prefix dolphin-desktop
```

## Run

```bash
cd dolphin-desktop
npm run renderer        # build the workspace UI into dolphin-web/dist-desktop
npm start               # starts the app; the helper runs from dolphin-backend/venv
```

On Linux without a SUID sandbox helper, run `npx electron --no-sandbox .` after
`npm run build`.

The helper keeps its data in `~/.dolphin-server`. Set `DOLPHIN_HOME` to use a
scratch folder instead. On first start it also sets up memory (a GBrain, about
400 MB); set `DOLPHIN_GBRAIN=off` to skip that while developing.

## Test

```bash
cd dolphin-backend && ./venv/bin/python -m pytest tests -q
cd ../dolphin-web && npm run build && npx vitest run
cd ../dolphin-desktop && npm test        # Electron tests under xvfb-run, one at a time
```

The Electron tests give every app a scratch `HOME` or `DOLPHIN_HOME`. Anything
that opens a terminal also gets a scratch `TMUX_TMPDIR`, with `TMUX` and
`TMUX_PANE` removed: tmux ignores `TMUX_TMPDIR` when `TMUX` is set, so a test
run from inside tmux would otherwise create sessions on your own tmux server.
The SSH test needs `sshd` on localhost and is skipped without it.

## Package

PyInstaller cannot cross-compile, so each platform's helper is built on that
platform.

```bash
cd dolphin-desktop
./scripts/build-helper.sh                         # helper-bundles/<platform>-<arch>[.tar.xz]
./scripts/smoke-helper.sh helper-bundles/linux-x64
npm run dist                                      # release/: AppImage and deb, or dmg on macOS
DOLPHIN_DESKTOP_APP=$PWD/release/linux-unpacked/dolphin-desktop \
  xvfb-run -a node --test test/packaged.test.mjs  # the packaged app's first run, empty HOME
```

A local build carries only its own platform's helper, so it can reach SSH hosts
of that platform only. Release builds carry every helper.

## Release

Bump `version` in `dolphin-desktop/package.json` and `VERSION` in
`dolphin-backend/app/version.py` together (a test checks they match), then push
a tag `desktop-vX.Y.Z`. The Desktop workflow builds the helper on Linux x64,
macOS arm64 and macOS x64, smoke-tests each with the host's tmux and with the
bundled one, packages each app with every helper, runs its first launch with an
empty `HOME`, and drafts a GitHub release with the installers.
