"""Shared helpers for the workflow tests: real, disposable git repositories
under a scratch HOME (so the user's ~/.gitconfig, hooks and identity never
apply), and a fake tmux for endpoint tests that must not start sessions."""

from __future__ import annotations

import subprocess
import uuid
from datetime import datetime, timezone
from pathlib import Path

import pytest

from app import tmux_service
from app.tmux_service import TmuxSessionInfo


def git(cwd: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=cwd, check=True, capture_output=True, text=True
    ).stdout.strip()


@pytest.fixture
def scratch_home(tmp_path, monkeypatch) -> Path:
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    for key in ("AUTHOR", "COMMITTER"):
        monkeypatch.setenv(f"GIT_{key}_NAME", "Test")
        monkeypatch.setenv(f"GIT_{key}_EMAIL", "test@example.com")
    monkeypatch.delenv("CLAUDE_CONFIG_DIR", raising=False)
    monkeypatch.delenv("CODEX_HOME", raising=False)
    tmux_dir = tmp_path / "tmux"
    tmux_dir.mkdir()
    monkeypatch.setenv("TMUX_TMPDIR", str(tmux_dir))
    monkeypatch.delenv("TMUX", raising=False)
    monkeypatch.delenv("TMUX_PANE", raising=False)
    return home


def make_repo(root: Path, name: str = "demo") -> Path:
    repo = root / name
    repo.mkdir(parents=True)
    git(repo, "init", "-q", "-b", "main")
    (repo / "README.md").write_text("demo\n")
    (repo / ".gitignore").write_text(".env*\n!.env.example\nnode_modules/\nsetup-ran.txt\n")
    git(repo, "add", ".")
    git(repo, "commit", "-q", "-m", "init")
    return repo


def add_upstream(repo: Path) -> Path:
    remote = repo.parent / f"{repo.name}-remote.git"
    git(repo.parent, "init", "-q", "--bare", "-b", "main", str(remote))
    git(repo, "remote", "add", "origin", str(remote))
    git(repo, "push", "-q", "-u", "origin", "main")
    git(repo, "remote", "set-head", "origin", "main")
    return remote


def session_info(name: str, path: Path, panes: tuple[str, ...] = ()) -> TmuxSessionInfo:
    return TmuxSessionInfo(
        name=name, path=str(path), created_at=datetime.now(timezone.utc), windows=1,
        attached=False, current_command="bash", is_codex_running=False, pane_paths=panes,
    )


def unique_session(prefix: str = "t") -> str:
    return f"{prefix}-{uuid.uuid4().hex[:6]}-dolphin"


@pytest.fixture
def fake_tmux(monkeypatch) -> list[tuple]:
    """Every tmux call the workflow endpoints make, recorded instead of run."""
    calls: list[tuple] = []
    created: dict[str, Path] = {}

    async def create_session(path, project_name, requested_name=None, mode="shell"):
        name = requested_name or unique_session(project_name)
        created[name] = Path(path)
        calls.append(("create", Path(path), name, mode))
        return session_info(name, Path(path))

    async def start_claude(path, name, initial_prompt=None, run_id=None):
        calls.append(("claude", Path(path), name, initial_prompt))

    async def start_codex(path, name, initial_prompt=None, run_id=None):
        calls.append(("codex", Path(path), name, initial_prompt))

    async def run_in_session(path, name, command):
        calls.append(("run", Path(path), name, command))

    async def require_workspace_session(path, name, **_kwargs):
        # A session this fake started works where it was started.
        return session_info(name, created.get(name, Path(path)))

    async def kill_session(path, name):
        calls.append(("kill", Path(path), name))

    for attribute, fake in {
        "create_session": create_session, "start_claude": start_claude, "start_codex": start_codex,
        "run_in_session": run_in_session, "require_workspace_session": require_workspace_session,
        "kill_session": kill_session,
    }.items():
        monkeypatch.setattr(tmux_service, attribute, fake, raising=False)
    return calls
