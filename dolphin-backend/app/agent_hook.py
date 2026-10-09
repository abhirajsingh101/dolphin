"""Dolphin's agent hook: Claude Code and Codex call it at every Stop and prompt submit.

On every Stop it records the finished turn on the pane (``@dolphin-turn``) for
the backend's notification collector, but only when the agent running it is the
pane's own interactive agent (see ``owns_pane``): background agents that merely
inherited TMUX_PANE are ignored. For sessions the Dolphin chat delegated, it
also marks the pane working on prompt submit and finished on Stop, keeping the
agent's final reply as the result. It reads no transcript and sends nothing
over the network. Any failure exits zero and can never block Codex or Claude.

Standard library only: it runs from scripts/dolphin-automation-hook under the
system Python on this server, and as ``dolphin-helper hook`` in Dolphin Desktop.
"""

from __future__ import annotations

import json
import os
import sys
import subprocess
from datetime import datetime, timezone
from uuid import uuid4


MAX_INPUT_BYTES = 65_536
MAX_SUMMARY_CHARS = 300
TIMEOUT_SECONDS = 0.7
SUPPORTED_PROVIDERS = {"codex", "claude"}
SUPPORTED_EVENTS = {"user_prompt_submit", "stop"}


def _argument_value(argv: list[str], option: str) -> str | None:
    try:
        return argv[argv.index(option) + 1]
    except (ValueError, IndexError):
        return None


def build_envelope(
    raw: bytes,
    *,
    provider: str,
    event_name: str,
    environ,
) -> dict[str, object] | None:
    try:
        if (
            not raw
            or len(raw) > MAX_INPUT_BYTES
            or provider not in SUPPORTED_PROVIDERS
            or event_name not in SUPPORTED_EVENTS
        ):
            return None
        tmux_pane = environ.get("TMUX_PANE")
        if not isinstance(tmux_pane, str) or not tmux_pane:
            return None
        return {"provider": provider, "event_name": event_name, "tmux_pane": tmux_pane}
    except BaseException:
        return None


AGENT_COMMS = {"codex", "claude", "node"}  # the process that runs this hook


def _tty_of(pid: int) -> int:
    """tty_nr (field 7) from /proc/<pid>/stat; 0 means no controlling terminal."""
    stat = open(f"/proc/{pid}/stat", encoding="utf-8").read()
    return int(stat[stat.rindex(")") + 2:].split()[4])


def _parent_of(pid: int) -> int:
    for line in open(f"/proc/{pid}/status", encoding="utf-8"):
        if line.startswith("PPid:"):
            return int(line.split()[1])
    return 0


def _ps_row(pid: int) -> tuple[int, str, str] | None:
    """(parent, terminal, command) from ps, for systems without /proc (macOS)."""
    result = subprocess.run(["ps", "-o", "ppid=,tty=,comm=", "-p", str(pid)],
                            capture_output=True, text=True, timeout=TIMEOUT_SECONDS)
    parts = result.stdout.strip().split(None, 2)
    if result.returncode != 0 or len(parts) < 3:
        return None
    return int(parts[0]), parts[1], os.path.basename(parts[2])


def _same_terminal(ps_terminal: str, device_path: str) -> bool:
    """ps prints /dev/pts/59 as "pts/59" (Linux) and /dev/ttys003 as "s003" (macOS)."""
    if ps_terminal in ("", "?", "??", "-"):
        return False
    name = device_path.removeprefix("/dev/")
    return ps_terminal in (name, name.removeprefix("tty"))


def _owns_pane_ps(device_path: str) -> bool:
    """macOS: compare the nearest agent's terminal name with the pane's."""
    pid = os.getppid()
    for _ in range(12):
        if pid <= 1:
            return False
        row = _ps_row(pid)
        if row is None:
            return False
        parent, terminal, command = row
        if command in AGENT_COMMS:
            return _same_terminal(terminal, device_path)
        pid = parent
    return False


def owns_pane(tmux_pane: str) -> bool:
    """True only when the agent running this hook is the pane's own interactive
    agent: its controlling terminal is the pane's terminal.

    TMUX_PANE alone is not enough. Anything started from a pane inherits it:
    a Codex app-server daemon, a backgrounded `codex exec` research run, a
    detached script's agents. Those keep finishing turns long after the pane
    went idle and would be reported as that pane's work. They run with no
    controlling terminal, so the nearest codex/claude/node ancestor decides.
    Shells and interpreters in between (a tool's bash, this python) are skipped.
    """
    try:
        result = subprocess.run(["tmux", "display-message", "-p", "-t", tmux_pane, "#{pane_tty}"],
            capture_output=True, text=True, timeout=TIMEOUT_SECONDS)
        tty = result.stdout.strip()
        if result.returncode != 0 or not tty.startswith("/dev/"):
            return False
        if not os.path.exists("/proc/self/stat"):
            return _owns_pane_ps(tty)
        device = os.stat(tty).st_rdev
        pid = os.getppid()
        for _ in range(12):
            if pid <= 1:
                return False
            if open(f"/proc/{pid}/comm", encoding="utf-8").read().strip() in AGENT_COMMS:
                tty_nr = _tty_of(pid)
                major, minor = (tty_nr >> 8) & 0xFFF, (tty_nr & 0xFF) | ((tty_nr >> 12) & 0xFFF00)
                return tty_nr != 0 and (major, minor) == (os.major(device), os.minor(device))
            pid = _parent_of(pid)
    except Exception:
        pass
    return False


def record_turn(envelope: dict, last_message=None) -> None:
    """Leave the finished turn on the pane for the notification collector."""
    try:
        if envelope['event_name'] != 'stop':
            return
        summary = ' '.join(last_message.split()) if isinstance(last_message, str) else ''
        turn = {
            'id': uuid4().hex,
            'provider': envelope['provider'],
            'finished_at': datetime.now(timezone.utc).isoformat(),
            'summary': summary[:MAX_SUMMARY_CHARS],
        }
        subprocess.run(['tmux', 'set-option', '-p', '-t', envelope['tmux_pane'], '@dolphin-turn', json.dumps(turn)],
            capture_output=True, timeout=TIMEOUT_SECONDS)
    except Exception:
        pass  # A missed notification must never interrupt an agent.


def track_chat_work(envelope: dict, last_message=None) -> None:
    """Observe only explicitly tracked panes. No model, transcript or prompt read."""
    try:
        pane = envelope['tmux_pane']
        option = '@dolphin-chat-work'
        result = subprocess.run(['tmux', 'show-options', '-qv', '-t', pane, option],
            capture_output=True, text=True, timeout=TIMEOUT_SECONDS)
        work = json.loads(result.stdout)
        if work.get('pane_id') != pane:
            return
        if envelope['event_name'] == 'stop':
            if not work.get('finished_at'):
                if isinstance(last_message, str) and last_message.strip():
                    work['output'] = last_message[-24000:]
                    work['output_source'] = 'agent_final_reply'
                else:
                    capture = subprocess.run(['tmux', 'capture-pane', '-p', '-J', '-t', pane, '-S', '-160'],
                        capture_output=True, text=True, timeout=TIMEOUT_SECONDS)
                    if capture.returncode == 0:
                        work['output'] = capture.stdout[-24000:]
                        work['output_source'] = 'terminal_excerpt'
            work['state'] = 'stopped'
            work['finished_at'] = work.get('finished_at') or datetime.now(timezone.utc).isoformat()
        else:
            work['state'] = 'working'
        work['close_token'] = uuid4().hex if work['state'] == 'stopped' else ''
        subprocess.run(['tmux', 'set-option', '-t', pane, option, json.dumps(work),
            ';', 'set-option', '-t', pane, '@dolphin-chat-work-close-token', work['close_token']],
            capture_output=True, timeout=TIMEOUT_SECONDS)
    except Exception:
        pass  # Never interrupt an agent because optional tracking failed.


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    provider = _argument_value(argv, "--provider") or ""
    try:
        raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
        envelope = build_envelope(
            raw,
            provider=provider,
            event_name=_argument_value(argv, "--event") or "",
            environ=os.environ,
        )
        if envelope is not None and owns_pane(envelope["tmux_pane"]):
            last_message = json.loads(raw).get('last_assistant_message')
            record_turn(envelope, last_message)
            track_chat_work(envelope, last_message)
    except BaseException:
        pass
    # Current Codex Stop hooks require JSON when they write stdout. An empty
    # object is a valid no-op for both Stop and UserPromptSubmit; Claude also
    # accepts it. Never print diagnostics into the agent's context.
    if provider == "codex":
        sys.stdout.write("{}\n")
    return 0




if __name__ == "__main__":
    raise SystemExit(main())
