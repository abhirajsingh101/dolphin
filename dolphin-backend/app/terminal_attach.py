"""How Dolphin's tmux client attaches for a browser terminal.

The browser end is xterm.js 6. tmux passes true colour, OSC 52 clipboard,
OSC 8 hyperlinks, focus events and extended keys only to a client that
declares them with -T, which tmux 3.2 added ("hyperlinks" arrived in 3.4).
Dolphin Desktop's helper accepts a host tmux as old as 3.0, so every flag
here is gated on the installed version: an unknown flag fails the attach.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import re
import shutil
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field

from starlette.websockets import WebSocketDisconnect

TMUX_FEATURES_3_4 = ("RGB", "clipboard", "hyperlinks", "focus", "extkeys")
TMUX_FEATURES_3_2 = ("RGB", "clipboard", "focus", "extkeys")

# set-titles-string for sessions Dolphin creates: the pane title, which agents
# set with OSC 0/2, and nothing while it is still tmux's default (the host).
DOLPHIN_TITLE_FORMAT = "#{?#{==:#{pane_title},#{host}},,#{pane_title}}"

_VERSION = re.compile(r"(\d+)\.(\d+)")
PROBE_TIMEOUT = 5
_VERSIONS: dict[tuple[str, int, int], tuple[int, int]] = {}


def parse_tmux_version(text: str) -> tuple[int, int]:
    """`tmux -V` output as (major, minor); (0, 0) when it says nothing usable."""
    match = _VERSION.search(text)
    if match:
        return int(match.group(1)), int(match.group(2))
    if re.search(r"\bmaster\b", text):
        return (99, 0)
    return (0, 0)


def tmux_terminal_features(version: tuple[int, int]) -> tuple[str, ...]:
    if version >= (3, 4):
        return TMUX_FEATURES_3_4
    if version >= (3, 2):
        return TMUX_FEATURES_3_2
    return ()


def tmux_attach_command(
    binary: str,
    session_name: str,
    version: tuple[int, int],
    *,
    preview: bool = False,
) -> list[str]:
    """The argv for one browser terminal's tmux client.

    A preview neither resizes the session (ignore-size) nor types into it
    (read-only), so glancing at a session never reflows the user's other
    clients. Before 3.2 only -r exists, which still keeps it read-only.
    """
    command = [binary]
    features = tmux_terminal_features(version)
    if features:
        command += ["-T", ",".join(features)]
    command += ["attach-session", "-t", session_name]
    if preview:
        command += ["-f", "ignore-size,read-only"] if version >= (3, 2) else ["-r"]
    return command


def tmux_attach_env(base: Mapping[str, str]) -> dict[str, str]:
    env = dict(base)
    env["TERM"] = "xterm-256color"
    env["COLORTERM"] = "truecolor"
    return env


def binary_key(binary: str) -> tuple[str, int, int] | None:
    """Identity of the executable: resolved path, mtime and size, so a
    replaced or upgraded tmux is probed again. None when it cannot be found."""
    resolved = shutil.which(binary) or binary
    try:
        stat = os.stat(resolved)
    except OSError:
        return None
    return (resolved, stat.st_mtime_ns, stat.st_size)


async def installed_tmux_version(binary: str) -> tuple[int, int]:
    """The version of `binary`, read once per installed file.

    Only a parsed answer is cached; a spawn error or timeout reads as (0, 0)
    for this call and is tried again on the next.
    """
    key = binary_key(binary)
    if key is None:
        return (0, 0)
    cached = _VERSIONS.get(key)
    if cached is not None:
        return cached
    try:
        process = await asyncio.create_subprocess_exec(
            binary,
            "-V",
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
    except OSError:
        return (0, 0)
    try:
        out, _ = await asyncio.wait_for(process.communicate(), timeout=PROBE_TIMEOUT)
    except asyncio.TimeoutError:
        return (0, 0)
    finally:
        if process.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                process.kill()
            await asyncio.shield(process.wait())
    version = parse_tmux_version(out.decode(errors="replace"))
    if version != (0, 0):
        _VERSIONS[key] = version
    return version


DEFAULT_PTY_SIZE = (120, 36)
INITIAL_RESIZE_TIMEOUT_SECONDS = 2.0
MAX_EARLY_INPUT_BYTES = 64 * 1024
PREVIEW_FIXED_SIZE = (300, 120)


def bounded_pty_size(cols: object, rows: object) -> tuple[int, int]:
    """The same bounds every resize has always had (main._resize_pty)."""
    return (
        max(20, min(int(cols or DEFAULT_PTY_SIZE[0]), 300)),
        max(8, min(int(rows or DEFAULT_PTY_SIZE[1]), 120)),
    )


@dataclass
class InitialAttach:
    size: tuple[int, int]
    early_input: list[bytes] = field(default_factory=list)
    disconnected: bool = False


async def await_initial_size(
    receive: Callable[[], Awaitable[dict]],
    *,
    timeout: float = INITIAL_RESIZE_TIMEOUT_SECONDS,
) -> InitialAttach:
    """Read the socket until the browser says how big it is.

    Spawning the tmux client at a guessed 120x36 and correcting it a moment
    later resized the session twice for every other client attached to it.
    Keys that arrive first are kept, in order, and written after the spawn.
    """
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    early: list[bytes] = []
    buffered = 0

    def keep(data: bytes) -> None:
        # Bounded: a client that never sends a size cannot grow this forever.
        nonlocal buffered
        room = MAX_EARLY_INPUT_BYTES - buffered
        if room > 0:
            early.append(data[:room])
            buffered += min(len(data), room)
    while True:
        remaining = deadline - loop.time()
        if remaining <= 0:
            return InitialAttach(DEFAULT_PTY_SIZE, early)
        try:
            message = await asyncio.wait_for(receive(), remaining)
        except asyncio.TimeoutError:
            return InitialAttach(DEFAULT_PTY_SIZE, early)
        except (RuntimeError, WebSocketDisconnect):
            return InitialAttach(DEFAULT_PTY_SIZE, early, disconnected=True)
        if message.get("type") == "websocket.disconnect":
            return InitialAttach(DEFAULT_PTY_SIZE, early, disconnected=True)
        if message.get("bytes") is not None:
            keep(message["bytes"])
            continue
        text = message.get("text")
        if not text:
            continue
        try:
            payload = json.loads(text)
        except json.JSONDecodeError:
            continue
        if not isinstance(payload, dict):
            continue
        if payload.get("type") == "resize":
            return InitialAttach(bounded_pty_size(payload.get("cols"), payload.get("rows")), early)
        if payload.get("type") == "input":
            data = str(payload.get("data", ""))
            if data:
                keep(data.encode())
