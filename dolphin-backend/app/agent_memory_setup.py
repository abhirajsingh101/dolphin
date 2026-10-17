"""Take Dolphin's memory out of Claude Code and Codex, where 0.2 put it.

Dolphin 0.2 offered to register its brain with each agent as the MCP server
"dolphin-memory" (through the launcher <DOLPHIN_HOME>/bin/dolphin-memory).
Agents no longer get memory tools: Dolphin's brain follows their work from
their transcripts, and an extra server in every session only costs tokens.
At startup, each registration Dolphin made is removed through the agent's own
`mcp remove`, which owns its config file, and the launcher is deleted.
"""

from __future__ import annotations

import json
import os
import subprocess
import tomllib
from pathlib import Path

from . import agent_clis

NAME = "dolphin-memory"
AGENTS = ("claude", "codex")


def launcher_path() -> Path:
    home = Path(os.getenv("DOLPHIN_HOME") or Path.home() / ".dolphin-server")
    return home / "bin" / NAME


def _configured(agent: str) -> bool:
    try:
        if agent == "claude":
            data = json.loads((Path.home() / ".claude.json").read_text())
            return NAME in (data.get("mcpServers") or {})
        config = tomllib.loads((Path.home() / ".codex" / "config.toml").read_text())
        return NAME in (config.get("mcp_servers") or {})
    except (OSError, ValueError, tomllib.TOMLDecodeError):
        return False


def remove() -> list[str]:
    """Remove Dolphin's memory from each agent that has it. Returns the agents changed."""
    removed = []
    paths = agent_clis.locate()
    for agent in AGENTS:
        cli = paths.get(agent)
        if cli is None or not _configured(agent):
            continue
        command = [cli, "mcp", "remove", *(["-s", "user"] if agent == "claude" else []), NAME]
        try:
            subprocess.run(command, capture_output=True, text=True, timeout=60)
        except (OSError, subprocess.TimeoutExpired):
            continue
        if not _configured(agent):
            removed.append(agent)
    launcher_path().unlink(missing_ok=True)
    return removed
