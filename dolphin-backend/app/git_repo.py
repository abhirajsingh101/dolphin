"""Read-only git facts for Dolphin: the sidebar's branch and change count, the
window title, and the diff panel.

Every call has a timeout and runs with GIT_OPTIONAL_LOCKS=0, so a status poll
never takes the index lock an agent's own `git commit` is about to need, and
GIT_TERMINAL_PROMPT=0, so nothing ever waits for a password.

All functions are synchronous; callers run them with asyncio.to_thread.
"""

from __future__ import annotations

import os
import re
import shutil
import stat
import threading
import subprocess
from dataclasses import dataclass
from pathlib import Path

GIT_TIMEOUT_SECONDS = 10.0

# Config that would run a program (a filesystem monitor hook) is switched off for
# every call; status must only read.
_SAFE_CONFIG = ("-c", "core.fsmonitor=false")


class GitError(RuntimeError):
    """git is missing, timed out, or failed in a way the caller should report."""


def _env() -> dict[str, str]:
    env = dict(os.environ)
    env.update({"GIT_OPTIONAL_LOCKS": "0", "GIT_TERMINAL_PROMPT": "0", "LC_ALL": "C"})
    return env


def run_git(
    cwd: Path, *args: str, check: bool = True, timeout: float = GIT_TIMEOUT_SECONDS
) -> subprocess.CompletedProcess[str]:
    binary = shutil.which("git")
    if binary is None:
        raise GitError("git is not installed on this machine.")
    try:
        result = subprocess.run(
            [binary, *_SAFE_CONFIG, *args], cwd=cwd, capture_output=True, text=True,
            timeout=timeout, env=_env(),
        )
    except subprocess.TimeoutExpired as error:
        raise GitError(f"git {args[0]} took longer than {timeout:g} s in {cwd}.") from error
    except OSError as error:  # the folder is gone, or is not a folder
        raise GitError(f"{cwd}: {error.strerror or error}") from error
    if check and result.returncode != 0:
        raise GitError((result.stderr or result.stdout).strip() or f"git {args[0]} failed")
    return result


@dataclass(frozen=True)
class GitStatus:
    branch: str | None
    head: str | None
    upstream: str | None
    ahead: int
    behind: int
    dirty: int
    conflicted: int


def parse_status(text: str) -> GitStatus:
    """`git status --porcelain=v2 --branch` output, as counts."""
    branch = head = upstream = None
    ahead = behind = dirty = conflicted = 0
    for line in text.splitlines():
        if line.startswith("# branch.oid "):
            oid = line.split(" ", 2)[2]
            head = None if oid == "(initial)" else oid[:7]
        elif line.startswith("# branch.head "):
            name = line.split(" ", 2)[2]
            branch = None if name == "(detached)" else name
        elif line.startswith("# branch.upstream "):
            upstream = line.split(" ", 2)[2]
        elif line.startswith("# branch.ab "):
            plus, minus = line.split(" ")[2:4]
            ahead, behind = abs(int(plus)), abs(int(minus))
        elif line.startswith("u "):
            conflicted += 1
            dirty += 1
        elif line[:2] in ("1 ", "2 ", "? "):
            dirty += 1
    return GitStatus(branch, head, upstream, ahead, behind, dirty, conflicted)


def repo_status(path: Path) -> GitStatus | None:
    """The work tree's status, or None when `path` is not inside one."""
    result = run_git(
        Path(path), "status", "--porcelain=v2", "--branch", "--untracked-files=normal",
        check=False,
    )
    if result.returncode != 0:
        if "not a git repository" in result.stderr.lower():
            return None
        raise GitError(result.stderr.strip() or "git status failed")
    return parse_status(result.stdout)


def current_branch(repo: Path) -> str | None:
    result = run_git(Path(repo), "symbolic-ref", "--quiet", "--short", "HEAD", check=False)
    return result.stdout.strip() or None if result.returncode == 0 else None


# --- diffs ----------------------------------------------------------------------

EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
DIFF_MAX_BYTES = 1_000_000
UNTRACKED_LIMIT = 100
UNTRACKED_FILE_MAX_BYTES = 200_000


@dataclass(frozen=True)
class SessionDiff:
    repo: str
    base_ref: str
    base_sha: str
    diff: str
    truncated: bool
    untracked: int
    notes: tuple[str, ...] = ()


def _default_branches(repo: Path) -> list[str]:
    names = []
    origin = run_git(repo, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD", check=False)
    if origin.returncode == 0 and origin.stdout.strip():
        names.append(origin.stdout.strip())
    for name in ("main", "master"):
        if run_git(repo, "rev-parse", "--verify", "--quiet", f"refs/heads/{name}", check=False).returncode == 0:
            names.append(name)
    return names


def default_base(repo: Path) -> tuple[str, str]:
    """What a session's work is measured against: the commit where HEAD left
    the default branch (origin's, else main, else master), or HEAD itself, or
    the empty tree in a repository with no commits."""
    for name in _default_branches(repo):
        fork = run_git(repo, "merge-base", "HEAD", name, check=False)
        if fork.returncode == 0 and fork.stdout.strip():
            return name, fork.stdout.strip()
    head = run_git(repo, "rev-parse", "--verify", "--quiet", "HEAD", check=False)
    if head.returncode == 0:
        return "HEAD", head.stdout.strip()
    return "HEAD", EMPTY_TREE


# Never let a repository's own configuration or attributes run a program, and
# never let a stored value be read as an option.
_DIFF_FLAGS = ("--no-color", "--no-ext-diff", "--no-textconv")
_SHA = re.compile(r"[0-9a-f]{40}([0-9a-f]{24})?")


def _clip(text: str, max_bytes: int) -> str:
    data = text.encode("utf-8", "replace")
    if len(data) <= max_bytes:
        return text
    cut = data[:max_bytes]
    newline = cut.rfind(b"\n")
    return cut[: newline + 1].decode("utf-8", "ignore")


def session_diff(
    path: Path, base_sha: str | None = None, base_ref: str | None = None, max_bytes: int = DIFF_MAX_BYTES
) -> SessionDiff | None:
    """Everything in the work tree that differs from the base: commits since
    it, staged and unstaged edits, and new files. None outside a repository.

    Read-only and bounded: total size, the number of new files and the size of
    each are capped, binary files are summarised by git, symlinks are never
    followed, and what was left out is named in `notes`."""
    top = run_git(Path(path), "rev-parse", "--show-toplevel", check=False)
    if top.returncode != 0:
        return None
    repo = Path(top.stdout.strip())
    if base_sha:
        if not _SHA.fullmatch(base_sha):
            raise GitError("The recorded base is not a commit id.")
        ref, sha = base_ref or base_sha, base_sha
    else:
        ref, sha = default_base(repo)
    first = run_git_bounded(repo, "diff", *_DIFF_FLAGS, "-M", sha, "--", max_bytes=max_bytes)
    tracked, cut = first.text, first.truncated
    names = [n for n in run_git(repo, "ls-files", "--others", "--exclude-standard", "-z").stdout.split("\0") if n]
    parts, notes = [tracked], []
    size = len(tracked.encode("utf-8", "replace"))
    for name in names[:UNTRACKED_LIMIT]:
        if cut or size > max_bytes:
            break
        file = repo / name
        try:
            info = file.lstat()
        except OSError:
            continue
        if not stat.S_ISREG(info.st_mode):  # symlinks and specials: never followed
            continue
        if info.st_size > UNTRACKED_FILE_MAX_BYTES:
            notes.append(f"{name}: new file too large to show ({info.st_size} bytes)")
            continue
        more = run_git_bounded(
            repo, "diff", *_DIFF_FLAGS, "--no-index", "--", "/dev/null", name,
            max_bytes=max(0, max_bytes - size), check=False,
        )
        parts.append(more.text)
        size += len(more.text.encode("utf-8", "replace"))
        cut = cut or more.truncated
    if len(names) > UNTRACKED_LIMIT:
        notes.append(f"{len(names) - UNTRACKED_LIMIT} more new files not shown")
    text = "".join(parts)
    clipped = _clip(text, max_bytes)
    if cut or clipped != text:
        notes.append(f"diff cut at {max_bytes} bytes")
    return SessionDiff(str(repo), ref, sha, clipped, bool(notes), len(names), tuple(notes))


READ_CHUNK = 65_536


@dataclass(frozen=True)
class BoundedOutput:
    text: str
    truncated: bool
    returncode: int | None


def run_git_bounded(cwd: Path, *args: str, max_bytes: int, check: bool = True, timeout: float = 30.0) -> BoundedOutput:
    """Like run_git, but stdout is read in chunks and git is killed once
    `max_bytes` have arrived, so memory stays at the cap plus one chunk. The
    text is cut at a line boundary. stderr is discarded."""
    binary = shutil.which("git")
    if binary is None:
        raise GitError("git is not installed on this machine.")
    try:
        proc = subprocess.Popen(
            [binary, *_SAFE_CONFIG, *args], cwd=cwd, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, env=_env(),
        )
    except OSError as error:
        raise GitError(f"{cwd}: {error.strerror or error}") from error
    timer = threading.Timer(timeout, proc.kill)
    timed_out = False
    chunks: list[bytes] = []
    held = 0
    truncated = False
    timer.start()
    try:
        while True:
            chunk = os.read(proc.stdout.fileno(), READ_CHUNK)
            if not chunk:
                break
            chunks.append(chunk)
            held += len(chunk)
            if held > max_bytes:
                truncated = True
                break
    finally:
        timer.cancel()
        if proc.poll() is None and truncated:
            proc.kill()
        elif proc.poll() is None:
            proc.kill()  # the reader raised; never leave git behind
        proc.wait()
        proc.stdout.close()
    data = b"".join(chunks)
    if truncated:
        data = data[:max_bytes]
        data = data[: data.rfind(b"\n") + 1]
    elif proc.returncode in (-9,):
        raise GitError(f"git {args[0]} took longer than {timeout:g} s in {cwd}.")
    if check and not truncated and proc.returncode != 0:
        raise GitError(f"git {args[0]} failed")
    return BoundedOutput(data.decode("utf-8", "replace"), truncated, proc.returncode)
