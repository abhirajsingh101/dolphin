"""What Dolphin Desktop's first-run checklist and bug reports learn about a machine.

HOME is a scratch folder throughout: the real ~/.claude and ~/.codex are never read.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import agent_clis, desktop_environment as environment


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
    monkeypatch.setenv("DOLPHIN_HOME", str(tmp_path / ".dolphin-server"))
    for name in ("ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "DOLPHIN_TMUX_BIN"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(agent_clis, "locate", lambda refresh=False: {"claude": "/x/claude", "codex": "/x/codex", "npm": None, "brew": None})
    return tmp_path


def _fake_tmux(path: Path, output: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"#!/bin/sh\necho '{output}'\n")
    path.chmod(0o755)
    return path


def test_nobody_is_signed_in_on_a_fresh_machine(home):
    agents = {row["agent"]: row for row in environment.snapshot()["agents"]}
    assert agents["claude"] == {"agent": "claude", "found": True, "signed_in": False}
    assert agents["codex"] == {"agent": "codex", "found": True, "signed_in": False}


def test_claude_sign_in_is_its_credentials_file_or_its_account_entry(home):
    (home / ".claude").mkdir()
    (home / ".claude" / ".credentials.json").write_text('{"claudeAiOauth": {"accessToken": "SECRET-ACCESS"}}')
    assert environment.claude_signed_in(home) is True
    (home / ".claude" / ".credentials.json").unlink()
    # macOS keeps the token in the Keychain; ~/.claude.json then names the account.
    (home / ".claude.json").write_text(json.dumps({"oauthAccount": {"emailAddress": "someone@example.com"}}))
    assert environment.claude_signed_in(home) is True
    (home / ".claude.json").write_text(json.dumps({"numStartups": 3}))
    assert environment.claude_signed_in(home) is False
    (home / ".claude.json").write_text("{not json")
    assert environment.claude_signed_in(home) is False


def test_codex_sign_in_is_its_auth_file_even_through_a_symlink(home):
    target = home / "accounts" / "a" / "auth.json"
    target.parent.mkdir(parents=True)
    target.write_text('{"tokens": "SECRET-CODEX"}')
    (home / ".codex").mkdir()
    (home / ".codex" / "auth.json").symlink_to(target)
    assert environment.codex_signed_in(home) is True


def test_an_api_key_in_the_helpers_environment_counts(home, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-SECRET")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-SECRET2")
    assert environment.claude_signed_in(home) is True
    assert environment.codex_signed_in(home) is True


def test_nothing_it_reads_leaves_the_module_and_nothing_is_written(home, monkeypatch):
    (home / ".claude").mkdir()
    credentials = home / ".claude" / ".credentials.json"
    credentials.write_text('{"token": "SECRET-ACCESS"}')
    account = home / ".claude.json"
    account.write_text(json.dumps({"oauthAccount": {"emailAddress": "someone@example.com"}}))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-SECRET")
    before = {path: path.stat().st_mtime_ns for path in (credentials, account)}
    text = json.dumps(environment.snapshot())
    assert "SECRET" not in text and "someone@example.com" not in text
    assert {path: path.stat().st_mtime_ns for path in (credentials, account)} == before
    assert sorted(path.name for path in home.iterdir()) == [".claude", ".claude.json"]


def test_an_agent_that_is_not_installed_has_no_sign_in_answer(home, monkeypatch):
    monkeypatch.setattr(agent_clis, "locate", lambda refresh=False: {"claude": None, "codex": None, "npm": None, "brew": None})
    assert [row["signed_in"] for row in environment.snapshot()["agents"]] == [None, None]


def test_tmux_version_and_whether_it_is_dolphins_own(home, monkeypatch):
    system = _fake_tmux(home / "sysbin" / "tmux", "tmux 3.4")
    monkeypatch.setenv("PATH", f"{system.parent}:/usr/bin:/bin")
    assert environment.tmux_info() == {"version": "3.4", "bundled": False}
    bundled = _fake_tmux(home / ".dolphin-server" / "bin" / "tmux", "tmux 3.7c")
    monkeypatch.setenv("DOLPHIN_TMUX_BIN", str(bundled))
    assert environment.tmux_info() == {"version": "3.7c", "bundled": True}
    monkeypatch.setenv("DOLPHIN_TMUX_BIN", str(home / "missing"))
    assert environment.tmux_info() == {"version": None, "bundled": False}


def test_the_endpoint_exists_only_in_helper_mode(home, monkeypatch):
    from app.main import app

    client = TestClient(app)
    monkeypatch.delenv("DOLPHIN_HELPER_VERSION", raising=False)
    assert client.get("/api/desktop/environment").status_code == 404
    monkeypatch.setenv("DOLPHIN_HELPER_VERSION", "0.0.0-test")
    body = client.get("/api/desktop/environment").json()
    assert set(body) == {"helper_version", "tmux", "agents"}
    assert [row["agent"] for row in body["agents"]] == ["claude", "codex"]
