"""Dolphin 0.2 gave Claude Code and Codex its memory over MCP; it now takes
it out again. Fake claude/codex commands record the `mcp remove` call and
edit the config entry the way the real ones would."""

from __future__ import annotations

from pathlib import Path

import pytest

from app import agent_clis, agent_memory_setup as memory

FAKE = r"""#!/bin/sh
echo "$(basename "$0") $*" >> "$HOME/calls.log"
if [ "$(basename "$0")" = claude ]; then
  printf '{"mcpServers": {}}' > "$HOME/.claude.json"
else
  printf '[mcp_servers.other]\ncommand = "x"\n' > "$HOME/.codex/config.toml"
fi
"""


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
    monkeypatch.setenv("DOLPHIN_HOME", str(tmp_path / ".dolphin-server"))
    clis = {}
    for name in ("claude", "codex"):
        fake = tmp_path / "bin" / name
        fake.parent.mkdir(exist_ok=True)
        fake.write_text(FAKE)
        fake.chmod(0o755)
        clis[name] = str(fake)
    monkeypatch.setattr(agent_clis, "locate", lambda refresh=False: clis)
    return tmp_path


def test_memory_registered_by_dolphin_0_2_is_removed_from_both_agents(home):
    (home / ".claude.json").write_text('{"mcpServers": {"dolphin-memory": {"command": "x"}, "other": {}}}')
    (home / ".codex").mkdir()
    (home / ".codex" / "config.toml").write_text('[mcp_servers.dolphin-memory]\ncommand = "x"\n[mcp_servers.other]\ncommand = "x"\n')
    memory.launcher_path().parent.mkdir(parents=True)
    memory.launcher_path().write_text("#!/bin/sh\n")
    assert memory.remove() == ["claude", "codex"]
    assert (home / "calls.log").read_text().splitlines() == ["claude mcp remove -s user dolphin-memory", "codex mcp remove dolphin-memory"]
    assert not memory.launcher_path().exists()


def test_an_agent_without_dolphins_memory_is_left_alone(home):
    (home / ".claude.json").write_text('{"mcpServers": {"other": {}}}')
    assert memory.remove() == []
    assert not (home / "calls.log").exists()
