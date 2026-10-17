"""Dolphin's agent hook: Claude Code and Codex call it at every Stop and prompt submit.

On every Stop it records the finished turn on the pane (``@dolphin-turn``) for
the backend's notification collector, but only when the agent running it is the
pane's own interactive agent (see ``owns_pane``): background agents that merely
inherited TMUX_PANE are ignored. It also leaves the turn's state on the pane
(``@dolphin-turn-state``, see turn_state.py): working from prompt submit,
finished at Stop. For sessions the Dolphin chat delegated, it also tracks the
delegated work, keeping the agent's final reply as the result. It reads no
transcript, and the only request it makes is an empty nudge to this machine's
own helper (``nudge_helper``). Any failure exits zero and can never block
Codex or Claude.

A Claude turn that ends while its background agents or commands are still
running is not finished work: Claude ends its reply, then wakes when they
report back. Claude's Stop input does not say so, so ``pending_background``
counts unfinished launches in the transcript (structure only, never content)
and such a turn is neither recorded nor marked finished.

Standard library only: it runs from scripts/dolphin-automation-hook under the
system Python on this server, and as ``dolphin-helper hook`` in Dolphin Desktop.
"""

from __future__ import annotations

import http.client
import json
import os
import re
import socket
import sys
import subprocess
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from .turn_state import OPTION as TURN_STATE_OPTION, format_turn_state


MAX_INPUT_BYTES = 65_536
MAX_SUMMARY_CHARS = 300
TIMEOUT_SECONDS = 0.7
SUPPORTED_PROVIDERS = {"codex", "claude"}
SUPPORTED_EVENTS = {"user_prompt_submit", "stop"}
# How Claude Code's transcript records a background launch (the tool result's
# opening words) and its completion (a task notification naming the launch).
BACKGROUND_LAUNCHES = ("Async agent launched successfully", "Command running in background with ID")
NOTIFIED = re.compile(r"<tool-use-id>([^<]+)</tool-use-id>")
# A launch still unreported after this long (a dev server, say) stops holding back the turn.
PENDING_FOR = timedelta(hours=2)


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


def _text_of(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(block.get("text", "") for block in content if isinstance(block, dict))
    return ""


def pending_background(transcript_path, now: datetime | None = None) -> int:
    """Background agents and commands launched in this session that have not
    reported back yet. Reads the transcript's structure only; 0 when unsure."""
    if not transcript_path:
        return 0
    now = now or datetime.now(timezone.utc)
    launched: dict[str, datetime] = {}
    done: set[str] = set()
    try:
        with open(transcript_path, encoding="utf-8", errors="replace") as transcript:
            for line in transcript:
                launch = any(marker in line for marker in BACKGROUND_LAUNCHES)
                if not launch and "<task-notification>" not in line:
                    continue
                row = json.loads(line)
                if row.get("type") == "queue-operation":
                    content = row.get("content")
                elif row.get("type") == "user":
                    content = (row.get("message") or {}).get("content")
                else:
                    continue  # assistant text that merely mentions the words
                if isinstance(content, str) and content.lstrip().startswith("<task-notification>"):
                    done.update(NOTIFIED.findall(content))
                elif launch and isinstance(content, list):
                    at = datetime.fromisoformat(row.get("timestamp", "").replace("Z", "+00:00"))
                    for block in content:
                        if (isinstance(block, dict) and block.get("type") == "tool_result"
                                and _text_of(block.get("content")).startswith(BACKGROUND_LAUNCHES)):
                            launched[block.get("tool_use_id", "")] = at
    except (OSError, ValueError):
        return 0
    return sum(1 for tool_use_id, at in launched.items()
               if tool_use_id not in done and now - at < PENDING_FOR)


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


def record_state(envelope: dict, now: datetime | None = None) -> None:
    """Mark the pane working (prompt submitted) or finished (turn ended)."""
    try:
        state = "finished" if envelope["event_name"] == "stop" else "working"
        value = format_turn_state(state, now or datetime.now(timezone.utc))
        subprocess.run(["tmux", "set-option", "-p", "-t", envelope["tmux_pane"], TURN_STATE_OPTION, value],
                       capture_output=True, timeout=TIMEOUT_SECONDS)
    except Exception:
        pass  # A missed state must never interrupt an agent.


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


NUDGE_PATH = "/api/desktop/turn-nudge"
NUDGE_TIMEOUT_SECONDS = 0.5


class _UnixHTTPConnection(http.client.HTTPConnection):
    def __init__(self, path: str, timeout: float):
        super().__init__("dolphin", timeout=timeout)
        self._path = path

    def connect(self):
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(self.timeout)
        sock.connect(self._path)
        self.sock = sock


def helper_connection(environ, timeout: float):
    """A connection to this machine's Dolphin helper and its token, or None.
    Only a helper whose server.json says ``ready`` is usable."""
    home = environ.get("DOLPHIN_HOME") or os.path.join(os.path.expanduser("~"), ".dolphin-server")
    with open(os.path.join(home, "run", "server.json"), encoding="utf-8") as handle:
        server = json.load(handle)
    if not isinstance(server, dict) or server.get("state") != "ready":
        return None
    with open(os.path.join(home, "token"), encoding="utf-8") as handle:
        token = handle.read().strip()
    if isinstance(server.get("socket"), str):
        return _UnixHTTPConnection(server["socket"], timeout), token
    if isinstance(server.get("port"), int):
        return http.client.HTTPConnection("127.0.0.1", server["port"], timeout=timeout), token
    return None


def nudge_helper(environ) -> bool:
    """Tell this machine's Dolphin helper that a turn changed, so it looks now
    instead of at its next scan. The request carries nothing but the helper's
    token; a helper that is not running costs one failed connect."""
    try:
        found = helper_connection(environ, NUDGE_TIMEOUT_SECONDS)
        if found is None:
            return False
        connection, token = found
        try:
            connection.request("POST", NUDGE_PATH, body=b"",
                               headers={"X-Dolphin-Token": token, "Content-Length": "0"})
            return connection.getresponse().status == 204
        finally:
            connection.close()
    except Exception:
        return False


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
            payload = json.loads(raw)
            still_working = (provider == "claude" and envelope["event_name"] == "stop"
                             and pending_background(payload.get("transcript_path")) > 0)
            if not still_working:
                last_message = payload.get('last_assistant_message')
                record_turn(envelope, last_message)
                record_state(envelope)
                track_chat_work(envelope, last_message)
                nudge_helper(os.environ)
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
