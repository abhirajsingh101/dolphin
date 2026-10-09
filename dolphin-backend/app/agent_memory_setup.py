"""Give Claude Code and Codex Dolphin's memory, with consent.

Dolphin's chat reads and writes the machine's GBrain (app/brain.py). The agents
the chat starts, and the ones the user runs by hand, can share it: GBrain is
also an MCP server. This registers it with each agent as "dolphin-memory",
through the agent's own `mcp add` command, which owns its config file. The
server runs through a stable launcher, <DOLPHIN_HOME>/bin/dolphin-memory, with
only GBrain's seven memory verbs (recall, remember, entity, forget, ...).
"""

from __future__ import annotations

import json
import os
import shlex
import subprocess
import tomllib
from pathlib import Path
from typing import Any

from . import agent_clis, brain

NAME = "dolphin-memory"
AGENTS = ("claude", "codex")


def launcher_path() -> Path:
    home = Path(os.getenv("DOLPHIN_HOME") or Path.home() / ".dolphin-server")
    return home / "bin" / NAME


def write_launcher() -> Path:
    """The stable command agents run; it follows Dolphin's brain across upgrades."""
    path = launcher_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    if brain.mode() == "external":
        command = os.environ["DOLPHIN_GBRAIN_COMMAND"]
        body = f"exec {command} serve --surface verbs \"$@\"\n"
    else:
        paths = brain._paths()
        body = (f"GBRAIN_HOME={shlex.quote(str(paths['home']))}; export GBRAIN_HOME\n"
                f"exec {shlex.quote(str(paths['bun']))} {shlex.quote(str(paths['cli']))} serve --surface verbs \"$@\"\n")
    path.write_text("#!/bin/sh\n# Dolphin's memory (GBrain) as an MCP server for Claude Code and Codex.\n" + body)
    path.chmod(0o700)
    return path


def _configured(agent: str) -> bool:
    try:
        if agent == "claude":
            data = json.loads((Path.home() / ".claude.json").read_text())
            return NAME in (data.get("mcpServers") or {})
        config = tomllib.loads((Path.home() / ".codex" / "config.toml").read_text())
        return NAME in (config.get("mcp_servers") or {})
    except (OSError, ValueError, tomllib.TOMLDecodeError):
        return False


def status() -> list[dict[str, Any]]:
    paths = agent_clis.locate()
    memory = brain.ready()
    return [{
        "agent": agent,
        "cli_found": paths.get(agent) is not None,
        "memory_ready": memory,
        "connected": _configured(agent),
    } for agent in AGENTS]


def connect(agents: list[str]) -> list[dict[str, Any]]:
    if not brain.ready():
        raise RuntimeError("Dolphin's memory is not set up on this machine yet.")
    launcher = write_launcher()
    paths = agent_clis.locate()
    for agent in agents:
        if agent not in AGENTS:
            raise ValueError(f"unknown agent: {agent}")
        cli = paths.get(agent)
        if cli is None:
            raise RuntimeError(f"{agent} is not installed on this machine.")
        if _configured(agent):
            continue
        command = [cli, "mcp", "add", *(["-s", "user"] if agent == "claude" else []), NAME, "--", str(launcher)]
        result = subprocess.run(command, capture_output=True, text=True, timeout=60)
        if result.returncode != 0 or not _configured(agent):
            detail = (result.stderr or result.stdout).strip().splitlines()[-1:] or ["no detail"]
            raise RuntimeError(f"{agent} mcp add failed: {detail[0][:300]}")
    return status()
