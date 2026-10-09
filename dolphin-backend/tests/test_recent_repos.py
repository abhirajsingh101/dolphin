"""Recent git repositories for Dolphin Desktop's first run."""

from __future__ import annotations

import os
from pathlib import Path

from app import recent_repos


def _repo(path: Path, used: float) -> Path:
    (path / ".git").mkdir(parents=True)
    head = path / ".git" / "HEAD"
    head.write_text("ref: refs/heads/main\n")
    os.utime(head, (used, used))
    return path


def test_newest_first_skipping_linked_hidden_and_dependency_folders(tmp_path, monkeypatch):
    monkeypatch.setenv("DOLPHIN_WORKSPACE_ROOTS", str(tmp_path))
    _repo(tmp_path, 50)  # the root itself (a dotfiles home) is never a suggestion
    old = _repo(tmp_path / "projects" / "old", 100)
    new = _repo(tmp_path / "projects" / "new", 300)
    linked = _repo(tmp_path / "linked", 400)
    _repo(tmp_path / ".cache" / "hidden", 500)
    _repo(tmp_path / "web" / "node_modules" / "dep", 600)
    _repo(new / "nested", 700)  # inside a repo: not scanned
    _repo(tmp_path / "a" / "b" / "c" / "too-deep", 800)

    found = recent_repos.find(exclude={str(linked)})
    assert [item["path"] for item in found] == [str(new.resolve()), str(old.resolve())]
    assert found[0]["name"] == "new"


def test_limit_and_missing_root(tmp_path, monkeypatch):
    monkeypatch.setenv("DOLPHIN_WORKSPACE_ROOTS", f"{tmp_path}{os.pathsep}{tmp_path / 'absent'}")
    for index in range(4):
        _repo(tmp_path / f"r{index}", 100 + index)
    assert [item["name"] for item in recent_repos.find(limit=2)] == ["r3", "r2"]
