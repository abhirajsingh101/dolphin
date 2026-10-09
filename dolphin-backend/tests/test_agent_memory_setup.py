"""Giving Claude Code and Codex Dolphin's memory (GBrain over MCP), with consent.

Fake claude/codex commands stand in for the real ones: they record the
`mcp add` call and write the config entry the real ones would.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app import agent_clis, agent_memory_setup as memory, brain

FAKE = r"""#!/bin/sh
echo "$0 $*" >> "$HOME/calls.log"
if [ "$(basename "$0")" = claude ]; then
  printf '{"mcpServers": {"dolphin-memory": {"command": "%s"}}}' "$7" > "$HOME/.claude.json"
else
  mkdir -p "$HOME/.codex"; printf '[mcp_servers.dolphin-memory]\ncommand = "%s"\n' "$5" >> "$HOME/.codex/config.toml"
fi
"""


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
    monkeypatch.setenv("DOLPHIN_HOME", str(tmp_path / ".dolphin-server"))
    monkeypatch.delenv("DOLPHIN_GBRAIN_COMMAND", raising=False)
    monkeypatch.setenv("DOLPHIN_GBRAIN", "auto")
    clis = {}
    for name in ("claude", "codex"):
        fake = tmp_path / "bin" / name
        fake.parent.mkdir(exist_ok=True)
        fake.write_text(FAKE)
        fake.chmod(0o755)
        clis[name] = str(fake)
    monkeypatch.setattr(agent_clis, "locate", lambda refresh=False: clis)
    monkeypatch.setattr(brain, "ready", lambda: True)
    return tmp_path


def test_connect_registers_the_launcher_with_each_agent(home):
    assert [row["connected"] for row in memory.status()] == [False, False]
    rows = memory.connect(["claude", "codex"])
    assert [row["connected"] for row in rows] == [True, True]

    launcher = home / ".dolphin-server" / "bin" / "dolphin-memory"
    text = launcher.read_text()
    assert "serve --surface verbs" in text and f"GBRAIN_HOME={brain.base() / 'home'}" in text
    calls = (home / "calls.log").read_text().splitlines()
    assert calls[0].endswith(f"claude mcp add -s user dolphin-memory -- {launcher}")
    assert calls[1].endswith(f"codex mcp add dolphin-memory -- {launcher}")
    assert json.loads((home / ".claude.json").read_text())["mcpServers"]["dolphin-memory"]["command"] == str(launcher)

    # Already connected: nothing runs again.
    memory.connect(["claude", "codex"])
    assert len((home / "calls.log").read_text().splitlines()) == 2


def test_connect_refuses_without_memory_or_the_agent(home, monkeypatch):
    monkeypatch.setattr(brain, "ready", lambda: False)
    with pytest.raises(RuntimeError, match="not set up"):
        memory.connect(["claude"])
    monkeypatch.setattr(brain, "ready", lambda: True)
    monkeypatch.setattr(agent_clis, "locate", lambda refresh=False: {"claude": None, "codex": None})
    with pytest.raises(RuntimeError, match="not installed"):
        memory.connect(["claude"])
    with pytest.raises(ValueError):
        memory.connect(["vim"])
