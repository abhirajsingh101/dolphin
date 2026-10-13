"""A private tmux server for one test, and helpers that drive it.

TMUX_TMPDIR points at a short scratch directory and TMUX/TMUX_PANE are removed,
so every tmux command in the test, and every process it starts, talks to a
server of its own and never to the user's. Teardown ends that server's
sessions by name on its own socket; a tmux server with no sessions exits by
itself, so nothing broader is ever needed.
"""

from __future__ import annotations

import asyncio
import json
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

from app.tmux_service import _run_tmux

BACKEND = Path(__file__).resolve().parents[1]


@pytest.fixture
def scratch_tmux(monkeypatch):
    if shutil.which("tmux") is None:
        pytest.skip("tmux is not installed")
    # Short on purpose: a Unix socket path holds about 100 bytes.
    directory = Path(tempfile.mkdtemp(prefix="dt-"))
    monkeypatch.setenv("TMUX_TMPDIR", str(directory))
    # The scratch server's panes inherit these, so a hook run in one reaches
    # neither the real helper (~/.dolphin-server) nor the real home.
    home = directory / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("DOLPHIN_HOME", str(home / ".dolphin-server"))
    for name in ("TMUX", "TMUX_PANE", "DOLPHIN_TMUX_BIN"):
        monkeypatch.delenv(name, raising=False)
    socket = directory / f"tmux-{os.getuid()}" / "default"
    try:
        yield socket
    finally:
        listed = subprocess.run(["tmux", "-S", str(socket), "list-sessions", "-F", "#{session_name}"],
                                capture_output=True, text=True)
        for name in listed.stdout.split():
            subprocess.run(["tmux", "-S", str(socket), "kill-session", "-t", f"={name}"], capture_output=True)
        shutil.rmtree(directory, ignore_errors=True)


async def new_pane(name: str = "probe", path: str = "/tmp") -> str:
    await _run_tmux("new-session", "-d", "-s", name, "-c", path)
    _, pane, _ = await _run_tmux("display-message", "-p", "-t", f"{name}:0.0", "#{pane_id}")
    return pane.strip()


async def run_as_agent(pane: str, provider: str, event: str, payload: dict, work: Path,
                       *, env: dict[str, str] | None = None) -> None:
    """Run Dolphin's hook the way an agent does: from a process named after the
    agent, started in the pane, so the hook finds that it owns the pane."""
    work.mkdir(parents=True, exist_ok=True)
    (work / "payload.json").write_text(json.dumps(payload))
    exports = "".join(f"export {key}={shlex.quote(value)}\n" for key, value in (env or {}).items())
    agent = work / provider
    agent.write_text(
        f'#!/bin/bash\n{exports}cd "{BACKEND}" && "{sys.executable}" -m app.agent_hook '
        f'--provider {provider} --event {event} < "{work}/payload.json" > "{work}/out"\n'
        f'touch "{work}/done"\n'
    )
    agent.chmod(0o755)
    await _run_tmux("send-keys", "-t", pane, str(agent), "Enter")
    for _ in range(100):
        if (work / "done").exists():
            return
        await asyncio.sleep(0.1)
    raise AssertionError("the fake agent never ran")


async def pane_option(pane: str, option: str) -> str:
    _, raw, _ = await _run_tmux("show-options", "-p", "-qv", "-t", pane, option, check=False)
    return raw.strip()
