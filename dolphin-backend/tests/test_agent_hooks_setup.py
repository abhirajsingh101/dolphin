"""Turning on finished-turn notifications for Claude Code and Codex (Dolphin Desktop)."""

from __future__ import annotations

import json
import subprocess
import sys
import tomllib
from pathlib import Path

import pytest

from app import agent_hooks_setup as setup

BACKEND = Path(__file__).resolve().parents[1]


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("DOLPHIN_HOME", str(tmp_path / ".dolphin-server"))
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
    setup.write_shim(["/opt/dolphin/dolphin-helper"])
    return tmp_path


def test_install_adds_our_hook_and_keeps_everything_else(home):
    claude = home / ".claude" / "settings.json"
    claude.parent.mkdir()
    claude.write_text(json.dumps({"model": "opus", "hooks": {"Stop": [{"hooks": [{"type": "command", "command": "other-tool"}]}]}}))
    codex_config = home / ".codex" / "config.toml"
    codex_config.parent.mkdir()
    codex_config.write_text('# my settings\nmodel = "gpt"\n\n[features]\ngoals = true\n')

    rows = {row["agent"]: row for row in setup.install(["claude", "codex"])}
    assert rows["claude"]["installed"] and rows["codex"]["installed"]

    data = json.loads(claude.read_text())
    assert data["model"] == "opus"
    stop_commands = [h["command"] for entry in data["hooks"]["Stop"] for h in entry["hooks"]]
    assert stop_commands[0] == "other-tool"
    assert stop_commands[1] == f"{setup.shim_path()} --provider claude --event stop"
    assert data["hooks"]["UserPromptSubmit"][0]["hooks"][0]["command"].endswith("--event user_prompt_submit")
    assert (home / ".claude" / "settings.json.before-dolphin").exists()

    codex = json.loads((home / ".codex" / "hooks.json").read_text())
    assert codex["hooks"]["Stop"][0]["hooks"][0]["command"].endswith("--provider codex --event stop")
    text = codex_config.read_text()
    assert text.startswith("# my settings") and tomllib.loads(text)["features"] == {"goals": True, "hooks": True}

    setup.install(["claude", "codex"])  # a second run changes nothing
    assert len(json.loads(claude.read_text())["hooks"]["Stop"]) == 2
    assert text == codex_config.read_text()


def test_codex_feature_flag_is_added_when_missing_or_off(home):
    config = home / ".codex" / "config.toml"
    config.parent.mkdir()
    config.write_text('[features]\nhooks = false\n')
    setup.install(["codex"])
    assert tomllib.loads(config.read_text())["features"]["hooks"] is True

    config.write_text('model = "x"\n')
    setup.install(["codex"])
    assert tomllib.loads(config.read_text())["features"]["hooks"] is True


def test_the_servers_own_hook_counts_as_on(home):
    claude = home / ".claude" / "settings.json"
    claude.parent.mkdir()
    claude.write_text(json.dumps({"hooks": {"Stop": [{"hooks": [{"type": "command",
        "command": "/opt/dolphin-tasks/scripts/dolphin-automation-hook --provider claude --event stop"}]}]}}))
    row = next(row for row in setup.status() if row["agent"] == "claude")
    assert row["installed"] and row["via"] == "server"
    setup.install(["claude"])
    assert len(json.loads(claude.read_text())["hooks"]["Stop"]) == 1  # no second hook


def test_install_refuses_unknown_agents_and_a_missing_shim(home):
    with pytest.raises(ValueError):
        setup.install(["cursor"])
    setup.shim_path().unlink()
    with pytest.raises(FileNotFoundError):
        setup.install(["claude"])


def test_shim_runs_the_helper_hook():
    result = subprocess.run([sys.executable, "-m", "app.helper", "hook", "--provider", "codex", "--event", "stop"],
                            cwd=BACKEND, input=b'{"last_assistant_message":"x"}', capture_output=True, timeout=30)
    assert result.returncode == 0 and result.stdout == b"{}\n"
