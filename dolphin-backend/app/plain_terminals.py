"""Plain terminals: a shell in a project folder, with no tmux.

A tmux session outlives Dolphin; a plain terminal is the lighter thing a
terminal app gives you: a login shell on a pty, here for as long as this
helper runs. It is listed beside the project's tmux sessions as ``term:<n>``
(tmux never allows ``:`` in a session name, so the names cannot collide), and
tmux_service and the stream endpoint hand those names here, so the rest of
Dolphin treats it like any session.

The shell keeps running while no window shows it. Its last BUFFER_BYTES of
output are kept and replayed when a window attaches again (a hidden tab lets
go of its socket after a minute). It ends when its shell exits or the user
closes it.
"""

from __future__ import annotations

import asyncio
import contextlib
import fcntl
import json
import os
import pty
import re
import signal
import struct
import subprocess
import termios
import threading
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

PREFIX = "term:"
BUFFER_BYTES = 256 * 1024
MAX_TERMINALS = 32
RECENT_SECONDS = 10


def is_terminal(name: str) -> bool:
    return name.startswith(PREFIX)


@dataclass
class Terminal:
    number: int
    path: str
    created_at: datetime
    master_fd: int
    process: subprocess.Popen
    shell: str
    buffer: bytearray = field(default_factory=bytearray)
    listeners: set = field(default_factory=set)
    last_output_at: datetime | None = None
    size: tuple[int, int] = (120, 36)

    @property
    def name(self) -> str:
        return f"{PREFIX}{self.number}"


_terminals: dict[str, Terminal] = {}


def _counter_path() -> Path:
    home = Path(os.getenv("DOLPHIN_HOME") or Path.home() / ".dolphin-server")
    return home / "plain-terminals.json"


def _take_number() -> int:
    """The next terminal number, never reused across helper restarts: a saved
    session link, pin or tab for an old term:1 must not find a new shell."""
    path = _counter_path()
    try:
        number = int(json.loads(path.read_text()).get("next", 1))
    except (OSError, ValueError, AttributeError, TypeError):
        number = 1
    number = max(number, 1 + max((terminal.number for terminal in _terminals.values()), default=0))
    with contextlib.suppress(OSError):
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(".tmp")
        temporary.write_text(json.dumps({"next": number + 1}))
        os.replace(temporary, path)
    return number


def _error(message: str) -> Exception:
    from .tmux_service import TmuxServiceError

    return TmuxServiceError(message)


def _resize(fd: int, cols: int, rows: int) -> None:
    with contextlib.suppress(OSError):
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def _shell() -> str:
    shell = os.environ.get("SHELL") or ""
    if shell and os.path.exists(shell):
        return shell
    return next((candidate for candidate in ("/bin/zsh", "/bin/bash", "/bin/sh") if os.path.exists(candidate)), "/bin/sh")


def _environment() -> dict[str, str]:
    environment = {key: value for key, value in os.environ.items()
                   if not key.startswith(("TMUX", "DOLPHIN_HELPER", "CLAUDECODE"))}
    environment.update({"TERM": "xterm-256color", "COLORTERM": "truecolor", "TERM_PROGRAM": "Dolphin"})
    return environment


def _read(terminal: Terminal) -> None:
    try:
        data = os.read(terminal.master_fd, 65536)
    except BlockingIOError:
        return
    except OSError:
        data = b""
    if not data:
        _end(terminal)
        return
    terminal.buffer.extend(data)
    if len(terminal.buffer) > BUFFER_BYTES:
        del terminal.buffer[: len(terminal.buffer) - BUFFER_BYTES]
    terminal.last_output_at = datetime.now(timezone.utc)
    for queue in list(terminal.listeners):
        try:
            queue.put_nowait(data)
        except asyncio.QueueFull:
            # A window this far behind would show a stream cut mid-sequence:
            # end its socket instead; it reconnects and replays the buffer.
            terminal.listeners.discard(queue)
            while not queue.empty():
                queue.get_nowait()
            queue.put_nowait(None)


def _end(terminal: Terminal) -> None:
    """The shell exited (or was closed): forget the terminal, tell its windows."""
    try:  # the reader belongs to the running loop; at shutdown there may be none
        asyncio.get_running_loop().remove_reader(terminal.master_fd)
    except (RuntimeError, ValueError, OSError):
        pass
    with contextlib.suppress(OSError):
        os.close(terminal.master_fd)
    _terminals.pop(terminal.name, None)
    for queue in list(terminal.listeners):
        with contextlib.suppress(asyncio.QueueFull):
            queue.put_nowait(None)
    process = terminal.process
    if process.poll() is None:
        with contextlib.suppress(ProcessLookupError, OSError):
            os.killpg(process.pid, signal.SIGHUP)

        def reap() -> None:
            # A shell that ignores the hangup is stopped; either way it is reaped.
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                with contextlib.suppress(ProcessLookupError, OSError):
                    os.killpg(process.pid, signal.SIGKILL)
                with contextlib.suppress(subprocess.TimeoutExpired):
                    process.wait(timeout=3)

        threading.Thread(target=reap, name="terminal-reap", daemon=True).start()


async def create(workspace_path: Path):
    """Start a login shell in ``workspace_path``; returns its session info."""
    if len(_terminals) >= MAX_TERMINALS:
        raise _error(f"{MAX_TERMINALS} terminals are open. Close one to open another.")
    master_fd, slave_fd = pty.openpty()
    _resize(master_fd, 120, 36)
    shell = _shell()
    try:
        process = subprocess.Popen([shell, "-l"], cwd=str(workspace_path), env=_environment(),
                                   stdin=slave_fd, stdout=slave_fd, stderr=slave_fd,
                                   start_new_session=True, close_fds=True)
    except OSError as error:
        os.close(master_fd)
        raise _error(f"Could not start a shell: {error}") from error
    finally:
        os.close(slave_fd)
    os.set_blocking(master_fd, False)
    terminal = Terminal(_take_number(), str(workspace_path), datetime.now(timezone.utc), master_fd, process, Path(shell).name)
    _terminals[terminal.name] = terminal
    asyncio.get_running_loop().add_reader(master_fd, _read, terminal)
    return info(terminal)


def get(name: str) -> Terminal:
    terminal = _terminals.get(name)
    if terminal is None:
        raise _error("That terminal has closed.")
    return terminal


def info(terminal: Terminal):
    from .tmux_service import TmuxSessionInfo

    now = datetime.now(timezone.utc)
    recent = bool(terminal.last_output_at and (now - terminal.last_output_at).total_seconds() < RECENT_SECONDS)
    return TmuxSessionInfo(
        name=terminal.name, path=terminal.path, created_at=terminal.created_at, windows=1,
        attached=bool(terminal.listeners), current_command=terminal.shell, is_codex_running=False,
        has_recent_activity=recent, last_activity_at=terminal.last_output_at, pane_paths=(terminal.path,),
    )


def sessions() -> list:
    return [info(terminal) for terminal in list(_terminals.values())]


def close(name: str) -> None:
    _end(get(name))


async def write(name: str, data: bytes) -> None:
    """Every byte, waiting for room when the shell is not reading (main.write_all_to_pty)."""
    from .main import write_all_to_pty

    await write_all_to_pty(get(name).master_fd, data)


_ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|\r")


def snapshot(name: str, lines: int = 300):
    from .tmux_service import TmuxSnapshot

    terminal = get(name)
    text = _ANSI.sub("", terminal.buffer.decode("utf-8", errors="replace"))
    return TmuxSnapshot(session_name=name, content="\n".join(text.splitlines()[-max(1, lines):]),
                        captured_at=datetime.now(timezone.utc))


async def attach(websocket, name: str) -> None:
    """One window on a terminal: what it printed lately, then everything live."""
    from .terminal_attach import await_initial_size

    terminal = _terminals.get(name)
    if terminal is None:
        await websocket.send_json({"type": "error", "message": "That terminal has closed."})
        await websocket.close(code=1008)
        return
    initial = await await_initial_size(websocket.receive)
    if initial.disconnected:
        return
    cols, rows = initial.size
    if (cols, rows) != terminal.size:
        terminal.size = (cols, rows)
        _resize(terminal.master_fd, cols, rows)
    for data in initial.early_input:
        await write(name, data)
    queue: asyncio.Queue = asyncio.Queue(maxsize=4096)
    # What it printed so far, taken with the listener so nothing arrives twice.
    replay = bytes(terminal.buffer)
    terminal.listeners.add(queue)

    async def out() -> None:
        if replay:
            await websocket.send_bytes(replay)
        while True:
            data = await queue.get()
            if data is None:
                with contextlib.suppress(RuntimeError):
                    await websocket.close(code=1000)
                return
            await websocket.send_bytes(data)

    async def into() -> None:
        while True:
            message = await websocket.receive()
            if message["type"] == "websocket.disconnect":
                return
            if message.get("bytes") is not None:
                await write(name, message["bytes"])
                continue
            try:
                payload = json.loads(message.get("text") or "")
            except json.JSONDecodeError:
                continue
            if not isinstance(payload, dict):
                continue
            if payload.get("type") == "input" and payload.get("data"):
                await write(name, str(payload["data"]).encode())
            elif payload.get("type") == "resize":
                try:
                    size = (max(20, min(int(payload.get("cols") or 120), 300)), max(8, min(int(payload.get("rows") or 36), 120)))
                except (TypeError, ValueError):
                    continue
                if size != terminal.size:
                    terminal.size = size
                    _resize(terminal.master_fd, *size)

    tasks = {asyncio.create_task(out()), asyncio.create_task(into())}
    try:
        done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            with contextlib.suppress(Exception):
                task.result()
    finally:
        for task in tasks:
            task.cancel()
        terminal.listeners.discard(queue)


def close_all() -> None:
    for terminal in list(_terminals.values()):
        _end(terminal)
