"""Recently used git repositories under the workspace roots, for Dolphin
Desktop's first run: "Open a folder to start", with likely folders one click
away.

The scan is bounded (depth, directory count and time) because it runs while a
new user waits, on home folders that can hold millions of files. It does not
descend into a repository once found, nor into hidden or dependency folders.
"""

from __future__ import annotations

import os
import time
from collections import deque
from pathlib import Path

from .tmux_service import workspace_roots

SKIP = {"node_modules", "Library", "Applications", "venv", "__pycache__", "dist", "build",
        "target", "vendor", "snap", "go", "Pictures", "Music", "Movies", "Videos"}
MAX_DEPTH = 3
MAX_DIRS = 6000
MAX_SECONDS = 2.0


def _last_used(repo: Path) -> float:
    git = repo / ".git"
    times = []
    for name in ("HEAD", "index", "FETCH_HEAD", "ORIG_HEAD"):
        try:
            times.append((git / name).stat().st_mtime)
        except OSError:
            pass
    if not times:  # a worktree's .git is a file
        try:
            times.append(git.stat().st_mtime)
        except OSError:
            return 0.0
    return max(times)


def find(limit: int = 6, exclude: set[str] | None = None) -> list[dict]:
    exclude = {str(Path(path).expanduser().resolve()) for path in exclude or ()}
    deadline = time.monotonic() + MAX_SECONDS
    visited = 0
    repos: dict[str, float] = {}
    queue: deque[tuple[Path, int]] = deque((root, 0) for root in workspace_roots() if root.is_dir())
    while queue and visited < MAX_DIRS and time.monotonic() < deadline:
        directory, depth = queue.popleft()
        visited += 1
        # A root that is itself a repo (a dotfiles home, say) is not a
        # suggestion; look inside it instead.
        if depth > 0 and (directory / ".git").exists():
            if str(directory) not in exclude:
                repos[str(directory)] = _last_used(directory)
            continue
        if depth >= MAX_DEPTH:
            continue
        try:
            with os.scandir(directory) as entries:
                for entry in entries:
                    if entry.name.startswith(".") or entry.name in SKIP:
                        continue
                    if entry.is_dir(follow_symlinks=False):
                        queue.append((Path(entry.path), depth + 1))
        except OSError:
            continue
    newest = sorted(repos.items(), key=lambda item: item[1], reverse=True)[:limit]
    return [{"name": Path(path).name, "path": path} for path, _ in newest]
