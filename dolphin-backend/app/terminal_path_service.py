"""Resolving path-shaped tokens from terminal output to downloadable files.

Terminal output is untrusted text. Every candidate that comes out of it is a
string that *wants* to become a filesystem path, and the only way it does is by
surviving, in order: length and control-character checks, lexical
normalisation, containment in a configured workspace root, the current
user's private Claude scratchpad namespace, or a file that user owns under
``/tmp``, and a dir-fd walk from that root that refuses a symlink at every
component.

Normalisation is deliberately lexical (``os.path.normpath``) and never
``Path.resolve()``. ``resolve()`` follows symlinks, so a link inside a root
could launder a path to a target outside it and still satisfy the containment
check that comes afterwards. ``tests/test_terminal_path_service.py`` pins that
case directly.

The search bases for relative candidates are supplied by the caller and are
derived server-side in ``main.py`` — never accepted from a client, which could
otherwise nominate ``/`` and enumerate the filesystem.
"""

from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path
import stat
from typing import Literal, Sequence
import uuid

from .workspace_file_service import (
    OpenedWorkspaceFile,
    WorkspaceFileError,
    lstat_within_root,
    open_workspace_file,
)
from .tmux_service import workspace_roots

MAX_CANDIDATES = 300
MAX_CANDIDATE_LENGTH = 4096
TEMP_ROOT = Path("/tmp")

ResolvedKind = Literal[
    "file",
    "directory",
    "symlink",
    "special",
    "missing",
    "denied",
]


@dataclass(frozen=True)
class ResolvedTerminalPath:
    candidate: str
    path: str | None
    kind: ResolvedKind
    size_bytes: int | None = None


def _expand(candidate: str) -> str | None:
    """Normalise one raw candidate, or None if it cannot be a path at all."""
    if not candidate or len(candidate) > MAX_CANDIDATE_LENGTH:
        return None
    if any(ord(char) < 32 or ord(char) == 127 for char in candidate):
        return None
    if candidate.startswith("~"):
        expanded = os.path.expanduser(candidate)
        # expanduser returns its input unchanged for an unknown ~user.
        return None if expanded.startswith("~") else expanded
    return candidate


def _absolute_forms(expanded: str, bases: Sequence[Path]) -> list[Path]:
    if os.path.isabs(expanded):
        return [Path(os.path.normpath(expanded))]
    return [
        Path(os.path.normpath(os.path.join(str(base), expanded))) for base in bases
    ]


def _current_uid() -> int:
    return os.getuid()


def _claude_temp_name() -> str:
    return f"claude-{_current_uid()}"


def _private_claude_temp_root() -> Path | None:
    """Return Claude's current-user temp root only while it remains private."""

    root = TEMP_ROOT / _claude_temp_name()
    try:
        info = root.lstat()
    except OSError:
        return None
    if (
        not stat.S_ISDIR(info.st_mode)
        or stat.S_ISLNK(info.st_mode)
        or info.st_uid != _current_uid()
        or info.st_mode & 0o077
    ):
        return None
    return root


def _is_claude_scratchpad_path(path: Path, root: Path) -> bool:
    """Accept only Claude's project/session scratchpad artifact namespace."""

    try:
        parts = path.relative_to(root).parts
    except ValueError:
        return False
    if len(parts) < 4 or not parts[0].startswith("-") or parts[2] != "scratchpad":
        return False
    try:
        session_id = uuid.UUID(parts[1])
    except ValueError:
        return False
    return str(session_id) == parts[1].casefold()


def _root_for(path: Path) -> Path | None:
    for root in workspace_roots():
        if path == root or root in path.parents:
            return root
    claude_root = _private_claude_temp_root()
    if (
        claude_root is not None
        and claude_root in path.parents
        and _is_claude_scratchpad_path(path, claude_root)
    ):
        return claude_root
    if _is_temp_path(path):
        return TEMP_ROOT
    return None


def _is_temp_path(path: Path) -> bool:
    """Anything under /tmp except Claude's own namespace.

    Agents park screenshots and build output in /tmp, so it is searched like a
    root — but it is shared with every account on the machine. What makes a
    file here servable is ownership, checked by the caller on the leaf and
    again on the opened descriptor. Claude's ``claude-<uid>`` directory holds
    session transcripts and task output; it keeps the scratchpad-only rule
    above even when its permissions drift, rather than falling through here.
    """
    try:
        parts = path.relative_to(TEMP_ROOT).parts
    except ValueError:
        return False
    return bool(parts) and parts[0] != _claude_temp_name()


def _foreign_temp_file(root: Path, info: os.stat_result) -> bool:
    return root == TEMP_ROOT and info.st_uid != _current_uid()


def _classify(path: Path) -> ResolvedTerminalPath | None:
    """Classify one absolute, already-normalised path.

    Returns None when the path is not usable at all — outside every root, or
    behind a component the safe walk refused — so the caller can try the next
    base before giving up.
    """
    root = _root_for(path)
    if root is None:
        return None
    if path == root:
        return ResolvedTerminalPath(str(path), str(path), "directory", None)

    try:
        info = lstat_within_root(root, path.relative_to(root).as_posix())
    except WorkspaceFileError as error:
        if error.status_code == 404:
            return ResolvedTerminalPath(str(path), None, "missing", None)
        return None
    if _foreign_temp_file(root, info):
        return None

    mode = info.st_mode
    if stat.S_ISLNK(mode):
        return ResolvedTerminalPath(str(path), str(path), "symlink", None)
    if stat.S_ISDIR(mode):
        return ResolvedTerminalPath(str(path), str(path), "directory", None)
    if stat.S_ISREG(mode):
        return ResolvedTerminalPath(str(path), str(path), "file", info.st_size)
    return ResolvedTerminalPath(str(path), str(path), "special", None)


def resolve_terminal_paths(
    candidates: Sequence[str],
    *,
    bases: Sequence[Path],
) -> list[ResolvedTerminalPath]:
    """Resolve candidate tokens against the given base directories.

    A candidate that misses in one base is still tried against the rest: the
    pane's working directory is searched first because that is what an agent
    prints paths relative to, but a miss there must not shadow a hit in the
    project root.
    """
    results: list[ResolvedTerminalPath] = []

    for candidate in list(candidates)[:MAX_CANDIDATES]:
        expanded = _expand(candidate)
        resolved: ResolvedTerminalPath | None = None

        if expanded is not None:
            for absolute in _absolute_forms(expanded, bases):
                found = _classify(absolute)
                if found is None:
                    continue
                if resolved is None or found.kind != "missing":
                    resolved = found
                if found.kind != "missing":
                    break

        results.append(
            ResolvedTerminalPath(candidate, None, "denied", None)
            if resolved is None
            else ResolvedTerminalPath(
                candidate,
                resolved.path,
                resolved.kind,
                resolved.size_bytes,
            )
        )

    return results


def resolve_download_target(raw_path: str) -> tuple[Path, str]:
    """Validate an absolute path and return ``(root, relative_path)``.

    Runs every check in this module again from scratch. What the resolve
    endpoint returned is a rendering hint; this is the security boundary, and a
    request that never called resolve at all is subject to exactly the same
    checks.
    """
    expanded = _expand(raw_path)
    if expanded is None or not os.path.isabs(expanded):
        raise WorkspaceFileError("An absolute file path is required.", 400)

    path = Path(os.path.normpath(expanded))
    root = _root_for(path)
    if root is None or path == root:
        raise WorkspaceFileError(
            "That path is outside the allowed workspace roots.",
            403,
        )

    relative = path.relative_to(root).as_posix()
    info = lstat_within_root(root, relative)
    if _foreign_temp_file(root, info):
        raise WorkspaceFileError(
            "That temporary file belongs to another user.",
            403,
        )
    if stat.S_ISLNK(info.st_mode):
        raise WorkspaceFileError("Symbolic links cannot be opened.", 403)
    if not stat.S_ISREG(info.st_mode):
        raise WorkspaceFileError("Only regular files can be downloaded.", 415)
    return root, relative


def open_download_target(raw_path: str) -> OpenedWorkspaceFile:
    """Validate ``raw_path`` and open it for streaming.

    Ownership under /tmp is checked once more on the descriptor itself: the
    path checks above see a name, and another account that can write to a
    directory along the way could swap that name before it is opened.
    """
    root, relative = resolve_download_target(raw_path)
    opened = open_workspace_file(root, relative)
    if _foreign_temp_file(root, os.fstat(opened.fd)):
        opened.close()
        raise WorkspaceFileError(
            "That temporary file belongs to another user.",
            403,
        )
    return opened
