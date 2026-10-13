#!/usr/bin/env bash
# The README's hero: the packaged first run's screenshots (test/packaged.test.mjs,
# on a clean CI runner) as one looping GIF, 3 s a frame:
#   scripts/make-hero.sh SHOTS_DIR OUT.gif
# Only CI shots are used: a developer's screen can show their own repositories.
set -euo pipefail
SHOTS="$1"
OUT="$2"
FRAMES=(packaged-first-run.png packaged-terminal.png packaged-health.png)
command -v ffmpeg >/dev/null || { echo "make-hero: ffmpeg is required" >&2; exit 1; }
for name in "${FRAMES[@]}"; do
  [ -f "$SHOTS/$name" ] || { echo "make-hero: missing $SHOTS/$name" >&2; exit 1; }
done
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
# Every frame is brought to 1200x750 on its own first: a size change inside one
# ffmpeg input restarts the filter graph and drops frames.
FIT="scale=1200:750:force_original_aspect_ratio=decrease:flags=lanczos,pad=1200:750:(ow-iw)/2:(oh-ih)/2:color=0x0f1722"
i=0
for name in "${FRAMES[@]}"; do
  i=$((i + 1))
  ffmpeg -hide_banner -loglevel error -y -i "$SHOTS/$name" -vf "$FIT" -frames:v 1 "$WORK/$(printf 'frame-%02d.png' "$i")"
done
ffmpeg -hide_banner -loglevel error -y -framerate 1/3 -i "$WORK/frame-%02d.png" \
  -vf "split[a][b];[a]palettegen=max_colors=128:stats_mode=full[p];[b][p]paletteuse=dither=bayer:bayer_scale=3" \
  -loop 0 -fflags +bitexact -flags:v +bitexact "$OUT"
