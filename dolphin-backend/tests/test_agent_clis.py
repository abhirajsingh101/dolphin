"""Finding agent CLIs the way the user's terminal would (Dolphin Desktop)."""

from __future__ import annotations

import os
import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import agent_clis


def _executable(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("#!/bin/sh\nexit 0\n")
    path.chmod(0o755)
    return path


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
    monkeypatch.setenv("PATH", "/usr/bin:/bin")
    monkeypatch.setattr(agent_clis, "_extra_dirs", lambda: [tmp_path / ".local/bin"])
    monkeypatch.setattr(agent_clis, "_cache", None)
    return tmp_path


def test_login_shell_path_wins_over_the_helpers_own_path(home, monkeypatch):
    # A login shell whose profile adds a directory the helper never sees.
    codex = _executable(home / "nvm" / "bin" / "codex")
    shell = home / "fake-shell"
    shell.write_text(f'#!/bin/sh\nPATH="{codex.parent}:$PATH"\nexport PATH\nshift\nexec /bin/sh -c "$1"\n')
    shell.chmod(0o755)
    monkeypatch.setenv("SHELL", str(shell))

    paths = agent_clis.locate(refresh=True)
    assert paths["codex"] == str(codex)


def test_known_install_directory_is_the_fallback(home, monkeypatch):
    monkeypatch.setenv("SHELL", "/nonexistent/shell")
    claude = _executable(home / ".local" / "bin" / "claude")
    assert agent_clis.locate(refresh=True)["claude"] == str(claude)


def test_missing_agents_offer_an_install_that_starts_them(home, monkeypatch):
    monkeypatch.setenv("SHELL", "/nonexistent/shell")
    _executable(home / ".local" / "bin" / "npm")
    rows = {row["agent"]: row for row in agent_clis.status(refresh=True)}

    assert rows["codex"]["found"] is False
    assert rows["codex"]["install_command"] == agent_clis.NPM_CODEX_INSTALL
    assert rows["codex"]["install_then_start"].startswith(agent_clis.NPM_CODEX_INSTALL + " && ")
    assert rows["codex"]["install_then_start"].endswith("&& codex")
    assert rows["claude"]["install_command"] == agent_clis.CLAUDE_INSTALL


def test_codex_without_npm_or_brew_says_what_is_needed(home, monkeypatch):
    monkeypatch.setenv("SHELL", "/nonexistent/shell")
    monkeypatch.setattr(agent_clis, "_fallback", lambda tool: None)
    row = next(row for row in agent_clis.status(refresh=True) if row["agent"] == "codex")
    assert row["install_command"] is None
    assert "npm" in row["install_hint"]


def test_endpoint_exists_only_in_helper_mode(monkeypatch):
    from app.main import app

    monkeypatch.delenv("DOLPHIN_HELPER_VERSION", raising=False)
    with TestClient(app) as client:
        assert client.get("/api/desktop/agents").status_code == 404


def test_merge_path_keeps_the_current_order_and_adds_new_entries():
    assert agent_clis.merge_path("/a:/b", "/c:/a:/d") == "/a:/b:/c:/d"
    assert agent_clis.merge_path("/a:/b", None) == "/a:/b"
    assert agent_clis.merge_path("", "/c") == "/c"


def test_the_helper_adopts_the_login_shells_path(tmp_path, monkeypatch):
    agents = tmp_path / "agents"
    agents.mkdir()
    agent = agents / "dolphin-test-agent"
    agent.write_text("#!/bin/sh\n")
    agent.chmod(0o755)
    shell = tmp_path / "login-shell"
    # Like a real shell: profile output without a trailing newline, then the
    # command the helper passed (-ilc <command>) runs with the profile's PATH.
    shell.write_text(
        "#!/bin/sh\n"
        'printf "motd"\n'
        f'PATH="{agents}:/usr/bin"\n'
        'eval "$2"\n'
    )
    shell.chmod(0o755)
    monkeypatch.setenv("SHELL", str(shell))
    monkeypatch.setenv("PATH", "/usr/bin:/bin")
    assert shutil.which("dolphin-test-agent") is None

    agent_clis.adopt_login_path()

    assert os.environ["PATH"] == f"/usr/bin:/bin:{agents}"
    assert shutil.which("dolphin-test-agent") == str(agent)


def test_a_login_shell_that_fails_changes_nothing(tmp_path, monkeypatch):
    monkeypatch.setenv("SHELL", str(tmp_path / "no-such-shell"))
    monkeypatch.setenv("PATH", "/usr/bin:/bin")
    agent_clis.adopt_login_path()
    assert os.environ["PATH"] == "/usr/bin:/bin"
