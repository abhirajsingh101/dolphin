"""Dolphin Desktop: projects for the tmux sessions already running on a machine.

Connecting to a machine that has been in use for months should not start from
an empty sidebar. Each running session names a folder (where it started, or
where its panes are now); the folder's git repository, or the folder itself,
becomes a project, and the session then shows under it the way every session
inside a project's folder does (`list_workspace_sessions`).

Each folder is imported once. Folders already imported are remembered in the
helper's data directory, so a project the user removes stays removed even
while its sessions keep running.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from .helper import _paths, home
from .tmux_service import TmuxSessionInfo, workspace_roots


def _state_file() -> Path:
    return _paths(home())["data"] / "tmux-imported.json"


def imported() -> set[str]:
    try:
        return set(json.loads(_state_file().read_text()))
    except (OSError, ValueError, TypeError):
        return set()


def remember(paths: set[str]) -> None:
    state = _state_file()
    state.parent.mkdir(parents=True, exist_ok=True)
    temporary = state.with_suffix(".tmp")
    temporary.write_text(json.dumps(sorted(paths)))
    os.replace(temporary, state)


def project_dir(raw: str, roots: list[Path]) -> Path | None:
    """The project a session in `raw` belongs to: the nearest git repository
    above it, else the folder itself. None for a workspace root (a home
    folder is not a project), a hidden folder, or anywhere outside the roots,
    which Dolphin could not open sessions in anyway.

    The path stays as the session sees it: a symlinked project keeps the
    name it is used by, not its target's."""
    path = Path(os.path.normpath(Path(raw).expanduser()))
    if not path.is_absolute() or not path.is_dir():
        return None
    root = next((r for r in roots if path == r or r in path.parents), None)
    if root is None:  # reached through a symlink above the root
        path = _resolved(path)
        root = next((r for r in roots if path == r or r in path.parents), None)
    if root is None or path == root:
        return None
    if any(part.startswith(".") for part in path.relative_to(root).parts):
        return None
    for candidate in (path, *path.parents):
        if candidate == root:
            break
        if (candidate / ".git").exists():
            return candidate
    return path


def _resolved(path: str | Path) -> Path:
    try:
        return Path(path).expanduser().resolve()
    except OSError:
        return Path(path)


def plan(sessions: list[TmuxSessionInfo], linked: list[str], seen: set[str]) -> dict[str, list[str]]:
    """Folders to import, each with the sessions that brought it in. A folder
    inside an existing project already shows its sessions there; one inside a
    folder imported before was removed along with it."""
    roots = [Path(os.path.normpath(root)) for root in workspace_roots()]
    covered = [_resolved(path) for path in (*linked, *seen)]
    found: dict[str, list[str]] = {}
    for session in sessions:
        for raw in (session.path, *(session.pane_paths or ())):
            folder = project_dir(raw, roots)
            if folder is None:
                continue
            real = _resolved(folder)
            if not any(real == p or p in real.parents for p in covered):
                found.setdefault(str(folder), []).append(session.name)
            break
    return found
