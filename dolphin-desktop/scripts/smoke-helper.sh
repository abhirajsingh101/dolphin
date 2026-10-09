#!/usr/bin/env bash
# Smoke-test a built helper bundle on this machine, in a scratch home:
#   scripts/smoke-helper.sh helper-bundles/<platform>-<arch>
# It must start detached, answer /health, refuse requests without the token,
# serve System Health and the agent-CLI check with it, run a command in a real
# terminal (on a private tmux server), run the agent hook, and stop.
set -euo pipefail
BIN="$(cd "$1" && pwd)/dolphin-helper/dolphin-helper"
SCRATCH="$(mktemp -d)"
export DOLPHIN_HOME="$SCRATCH/home" DOLPHIN_WORKSPACE_ROOTS="$SCRATCH" TMUX_TMPDIR="$SCRATCH/tmux"
unset TMUX TMUX_PANE
mkdir -p "$SCRATCH/demo" "$TMUX_TMPDIR"
# The private tmux server goes with the scratch folder (either tmux, either socket).
trap 'status=$?
      if [ "$status" != 0 ]; then
        for log in "$DOLPHIN_HOME"/logs/*; do [ -f "$log" ] && { echo "--- $log" >&2; tail -n 80 "$log" >&2; }; done
      fi
      "$BIN" stop >/dev/null 2>&1 || true
      tmux kill-server >/dev/null 2>&1 || true; "$DOLPHIN_HOME/bin/tmux" kill-server >/dev/null 2>&1 || true
      rm -rf "$SCRATCH"; exit "$status"' EXIT

"$BIN" version
"$BIN" serve --detach
for _ in $(seq 1 240); do [ -f "$DOLPHIN_HOME/run/server.json" ] && break; sleep 0.5; done
SOCK="$(sed -n 's/.*"socket": *"\([^"]*\)".*/\1/p' "$DOLPHIN_HOME/run/server.json")"
for _ in $(seq 1 120); do [ -S "$SOCK" ] && break; sleep 0.5; done
TOKEN="$(cat "$DOLPHIN_HOME/token")"
field() { python3 -c 'import json, sys; print(json.load(sys.stdin)[sys.argv[1]])' "$1"; }
api() { curl -fsS --unix-socket "$SOCK" -H "X-Dolphin-Token: $TOKEN" -H 'Content-Type: application/json' "http://dolphin$1" "${@:2}"; }

curl -fsS --retry 30 --retry-delay 1 --retry-all-errors --unix-socket "$SOCK" http://dolphin/health; echo
code="$(curl -s -o /dev/null -w '%{http_code}' --unix-socket "$SOCK" http://dolphin/api/projects)"
[ "$code" = 401 ] || { echo "expected 401 without the token, got $code" >&2; exit 1; }
api /api/system-health/summary | grep -q '"cpu' || { echo "System Health returned no CPU figures" >&2; exit 1; }
api /api/desktop/agents | grep -q '"agent":"claude"'
api /api/desktop/recent-repos >/dev/null
# A shell in a pane must start and run commands: the helper's own libraries
# must not leak into it.
project="$(api /api/projects -X POST -d "{\"name\":\"demo\",\"path\":\"$SCRATCH/demo\"}" | field id)"
[ -n "$project" ] || { echo "could not create a project" >&2; exit 1; }
session="$(api "/api/projects/$project/tmux/sessions" -X POST -d '{"mode":"shell"}' | field name)"
sleep 1
api "/api/projects/$project/tmux/sessions/$session/input" -X POST -d '{"text":"echo SMOKE-$((6*7))","enter":true}' >/dev/null
for _ in $(seq 1 20); do api "/api/projects/$project/tmux/sessions/$session/snapshot" | grep -q 'SMOKE-42' && break; sleep 0.5; done
api "/api/projects/$project/tmux/sessions/$session/snapshot" | grep -q 'SMOKE-42' || {
  echo "the terminal did not run a command:" >&2; api "/api/projects/$project/tmux/sessions/$session/snapshot" >&2; exit 1; }
# Memory: the helper sets up a real GBrain in the background (this downloads
# Bun and GBrain). DOLPHIN_GBRAIN=off skips it.
if [ "${DOLPHIN_GBRAIN:-auto}" != off ]; then
  for _ in $(seq 1 300); do
    state="$(api /api/brain | field state)"
    [ "$state" = ready ] || [ "$state" = failed ] && break
    sleep 1
  done
  [ "$state" = ready ] || { echo "memory setup did not finish: $(api /api/brain)" >&2; cat "$DOLPHIN_HOME/gbrain/install.log" >&2; exit 1; }
  brain_dir="$(cd "$DOLPHIN_HOME/gbrain" && pwd -P)"  # the real path, as the helper uses
  gbrain() { env -i HOME="$HOME" PATH=/usr/bin:/bin GBRAIN_HOME="$brain_dir/home" \
    "$brain_dir/bun/bun" "$brain_dir/runtime/node_modules/gbrain/src/cli.ts" call "$@" | sed -n '/^[{[]/,$p'; }
  gbrain remember '{"fact":"Smoke test fact.","entity":"user","provenance":"smoke test"}' | grep -q '"inserted"'
  gbrain recall '{"query":"smoke"}' | grep -q 'Smoke test fact.'
  echo "memory ready: remember and recall work"
fi
echo '{}' | "$BIN" hook --provider codex --event stop >/dev/null
"$BIN" status
"$BIN" stop
echo "helper smoke test passed"
