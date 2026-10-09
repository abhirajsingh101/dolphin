#!/usr/bin/env bash
# Build the Dolphin helper as a self-contained folder for this machine's
# platform, plus a .tar.xz of it for uploading to SSH hosts:
#   helper-bundles/<platform>-<arch>/dolphin-helper/dolphin-helper
#   helper-bundles/<platform>-<arch>.tar.xz
# PyInstaller cannot cross-compile; CI runs this once per platform.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
BACKEND="$HERE/../dolphin-backend"
BUILD="$HERE/.helper-build"
case "$(uname -s)" in Darwin) PLATFORM=darwin ;; *) PLATFORM=linux ;; esac
case "$(uname -m)" in arm64|aarch64) ARCH=arm64 ;; *) ARCH=x64 ;; esac
OUT="$HERE/helper-bundles/$PLATFORM-$ARCH"
PYTHON="${PYTHON:-python3.12}"

mkdir -p "$BUILD"
if [ ! -x "$BUILD/venv/bin/python" ]; then
  "$PYTHON" -m venv "$BUILD/venv"
  "$BUILD/venv/bin/pip" install -q --upgrade pip
fi
"$BUILD/venv/bin/pip" install -q -r "$BACKEND/requirements.txt" pyinstaller==6.22.3

strip_flag=()
[ "$PLATFORM" = linux ] && strip_flag=(--strip)   # macOS: keep symbols, signing is simpler

( cd "$BACKEND" && "$BUILD/venv/bin/python" -m PyInstaller \
    --noconfirm --clean --log-level WARN --onedir \
    --name dolphin-helper --paths "$BACKEND" \
    --collect-submodules app --collect-submodules alembic \
    --collect-submodules sqlalchemy.dialects.sqlite --hidden-import aiosqlite --hidden-import greenlet \
    --collect-submodules uvicorn --hidden-import uvloop --hidden-import httptools \
    --hidden-import websockets.legacy.server \
    --add-data "$BACKEND/alembic.ini:." --add-data "$BACKEND/alembic:alembic" \
    --exclude-module tkinter --exclude-module pytest ${strip_flag[@]+"${strip_flag[@]}"} \
    --specpath "$BUILD" --workpath "$BUILD/work" --distpath "$BUILD/dist" \
    "$HERE/scripts/helper_entry.py" )

rm -rf "$OUT" "$OUT.tar.xz"
mkdir -p "$OUT"
cp -R "$BUILD/dist/dolphin-helper" "$OUT/dolphin-helper"
# The agent hook is the binary itself (`dolphin-helper hook`), reached through
# the stable shim the helper writes at <home>/bin/dolphin-hook.
# A static tmux for machines that have none (macOS ships without it). The
# helper uses it only when the host lacks tmux >= 3.0, on its own socket.
TMUX_VERSION=3.7c
TMUX_CACHE="$BUILD/tmux-$TMUX_VERSION-$PLATFORM-$ARCH"

# Download into $BUILD/downloads and check the pinned SHA-256.
fetch() {
  local url="$1" sum="$2" file="$BUILD/downloads/$(basename "$1")"
  mkdir -p "$BUILD/downloads"
  [ -f "$file" ] || curl -fsSL -o "$file.part" "$url" && { [ -f "$file" ] || mv "$file.part" "$file"; }
  local got
  if command -v sha256sum >/dev/null; then got="$(sha256sum "$file" | cut -d' ' -f1)"; else got="$(shasum -a 256 "$file" | cut -d' ' -f1)"; fi
  [ "$got" = "$sum" ] || { echo "checksum mismatch for $url: $got" >&2; rm -f "$file"; exit 1; }
  echo "$file"
}

if [ ! -x "$TMUX_CACHE/tmux" ]; then
  mkdir -p "$TMUX_CACHE"
  if [ "$PLATFORM" = linux ]; then
    # tmux's own static (musl) builds run on any Linux.
    case "$ARCH" in
      x64) asset=linux-x86_64; sum=cc56bd1cc873eb6089c615f0496b072385bda8a6d944069f38564a5d49c128aa ;;
      arm64) asset=linux-arm64; sum=29dcb978da2a4b0cf6790f9e004865dac239a3ba03bbf776dddacce23d03831b ;;
    esac
    tar -xzf "$(fetch "https://github.com/tmux/tmux-builds/releases/download/v$TMUX_VERSION/tmux-$TMUX_VERSION-$asset.tar.gz" "$sum")" -C "$TMUX_CACHE"
    tar -xzf "$(fetch "https://github.com/tmux/tmux-builds/releases/download/v$TMUX_VERSION/LICENSES.tar.gz" 094905d3ba42397c65fecd817dc29736dd14bd35e75600441403a365125f47d1)" -C "$TMUX_CACHE"
    found="$(find "$TMUX_CACHE" -type f -name tmux -perm -u+x | head -1)"
    [ "$found" = "$TMUX_CACHE/tmux" ] || mv "$found" "$TMUX_CACHE/tmux"
  else
    # tmux's macOS builds need macOS 15. Build for macOS 11+ instead, with
    # libevent and utf8proc linked in and ncurses from the system.
    export MACOSX_DEPLOYMENT_TARGET=11.0
    src="$BUILD/tmux-src" prefix="$BUILD/tmux-deps"
    rm -rf "$src" "$prefix"; mkdir -p "$src" "$prefix/include" "$prefix/lib"
    tar -xzf "$(fetch https://github.com/libevent/libevent/releases/download/release-2.1.12-stable/libevent-2.1.12-stable.tar.gz 92e6de1be9ec176428fd2367677e61ceffc2ee1cb119035037a27d346b0403bb)" -C "$src"
    tar -xzf "$(fetch https://github.com/JuliaStrings/utf8proc/releases/download/v2.12.0/utf8proc-2.12.0.tar.gz a393fbef160835fb315bc3e91ba8d86f7a73a7cec9e6198b6c60b848b498bfeb)" -C "$src"
    tar -xzf "$(fetch "https://github.com/tmux/tmux/releases/download/$TMUX_VERSION/tmux-$TMUX_VERSION.tar.gz" 7c60cae9a0e25288e2e24750aafc9e8800fc7fd4555e447e1b29ee4201cfb3bf)" -C "$src"
    jobs="$(sysctl -n hw.ncpu)"
    ( cd "$src/libevent-2.1.12-stable" && ./configure -q --prefix="$prefix" --disable-shared --enable-static \
        --disable-openssl --disable-samples --disable-libevent-regress && make -s -j"$jobs" && make -s install )
    ( cd "$src/utf8proc-2.12.0" && make -s -j"$jobs" libutf8proc.a && cp libutf8proc.a "$prefix/lib/" && cp utf8proc.h "$prefix/include/" )
    # PKG_CONFIG_LIBDIR hides Homebrew's ncurses, so the system one is used.
    ( cd "$src/tmux-$TMUX_VERSION" && PKG_CONFIG_LIBDIR="$prefix/lib/pkgconfig" ./configure -q --enable-utf8proc --disable-jemalloc \
        CFLAGS="-I$prefix/include" LDFLAGS="-L$prefix/lib" \
        LIBEVENT_CFLAGS="-I$prefix/include" LIBEVENT_LIBS="-L$prefix/lib -levent_core" && make -s -j"$jobs" )
    cp "$src/tmux-$TMUX_VERSION/tmux" "$TMUX_CACHE/tmux"
    cp "$src/tmux-$TMUX_VERSION/COPYING" "$TMUX_CACHE/COPYING-tmux"
    cp "$src/libevent-2.1.12-stable/LICENSE" "$TMUX_CACHE/LICENSE-libevent"
    cp "$src/utf8proc-2.12.0/LICENSE.md" "$TMUX_CACHE/LICENSE-utf8proc.md"
    # Only system libraries, and the deployment target we asked for.
    if otool -L "$TMUX_CACHE/tmux" | tail -n +2 | grep -vE '^\s+/(usr/lib|System)/'; then
      echo "tmux links a non-system library" >&2; exit 1
    fi
    otool -l "$TMUX_CACHE/tmux" | grep -A3 LC_BUILD_VERSION | grep -q 'minos 11.0' || { echo "tmux minos is not 11.0" >&2; exit 1; }
  fi
fi
mkdir -p "$OUT/dolphin-helper/tmux/terminfo"
cp "$TMUX_CACHE/tmux" "$OUT/dolphin-helper/tmux/tmux"
find "$TMUX_CACHE" -maxdepth 3 \( -iname 'LICENSE*' -o -iname 'COPYING*' \) -type f -exec cp {} "$OUT/dolphin-helper/tmux/" \; 2>/dev/null || true
# Terminfo for the entries tmux and its panes use, so a host without them still works.
for entry in tmux tmux-256color screen screen-256color xterm xterm-256color; do
  infocmp -x "$entry" > "$BUILD/$entry.src" 2>/dev/null && tic -x -o "$OUT/dolphin-helper/tmux/terminfo" "$BUILD/$entry.src" 2>/dev/null || true
done
# ncurses builds differ: some read hex folders (74/), others letters (t/). Ship both.
for dir in "$OUT/dolphin-helper/tmux/terminfo"/??; do
  [ -d "$dir" ] || continue
  letter="$(printf "\\x$(basename "$dir")")"
  cp -R "$dir" "$OUT/dolphin-helper/tmux/terminfo/$letter"
done
"$OUT/dolphin-helper/tmux/tmux" -V

tar -C "$OUT" -cJf "$OUT.tar.xz" dolphin-helper
"$OUT/dolphin-helper/dolphin-helper" version
du -sh "$OUT/dolphin-helper" "$OUT.tar.xz"
