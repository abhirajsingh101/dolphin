"""Worktrees for sessions: one branch and one folder per session, so several
agents can work on one repository at once without touching each other's files.

Where they live:  <repo-parent>/.dolphin-worktrees/<repo-name>/<branch-slug>

Beside the repository, not inside it and not under DOLPHIN_HOME, because:
- the folder stays under the same workspace root as the repository, so
  require_workspace_path allows sessions there with no new permission;
- tools that walk the repository (test runners, watchers, search) never see a
  second copy of it;
- tmux_service.path_in_workspace ties a session there to its project by path
  alone, with no database lookup on the hot listing path;
- fleet_worktrees uses the same folder, so there is one convention.
DOLPHIN_HOME was rejected: it is the helper's hidden folder, it need not sit
under a workspace root, and the web install has none.

Ignored `.env*` files are copied in (an agent's dev server needs them); tracked
ones are already in the checkout. `.dolphin/setup`, if present, is run by the
launch endpoint inside the session's terminal, where the user can see it.

Safety: nothing here deletes a folder unless git lists it as a worktree of the
repository, it sits under .dolphin-worktrees, it has no uncommitted or
untracked changes, no checked-out submodule, every ignored `.env*` entry in it is
an unchanged copy of the repository's, it has the expected branch checked out
(not a detached HEAD), and that branch and its HEAD commit are both reachable
from the target. `git worktree remove` runs without --force and the branch is
kept. What it does still delete: other ignored files (node_modules/, build
output, local config), which nothing here treats as work; the Archive
confirmation names them (deleted_on_archive).
"""

from __future__ import annotations

import filecmp
import os
import re
import secrets
import shutil
from dataclasses import dataclass
from pathlib import Path

from . import git_repo
from .tmux_service import workspace_roots, worktrees_dir

SETUP_PATH = Path(".dolphin") / "setup"
ENV_FILE_LIMIT = 50
ENV_FILE_MAX_BYTES = 1_000_000
_BRANCH = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$")


class WorktreeError(RuntimeError):
    def __init__(self, detail: str, status_code: int = 409):
        super().__init__(detail)
        self.detail = detail
        self.status_code = status_code


@dataclass(frozen=True)
class CreatedWorktree:
    repo: Path
    path: Path
    branch: str
    base_ref: str
    base_sha: str
    copied: list[str]


def _git(cwd: Path, *args: str, check: bool = True, timeout: float = git_repo.GIT_TIMEOUT_SECONDS):
    try:
        return git_repo.run_git(cwd, *args, check=check, timeout=timeout)
    except git_repo.GitError as error:
        raise WorktreeError(str(error)) from error


def repo_root(path: Path) -> Path:
    result = _git(Path(path), "rev-parse", "--show-toplevel", check=False)
    if result.returncode != 0:
        raise WorktreeError(f"{path} is not a git repository.", 400)
    return Path(result.stdout.strip()).resolve()


def suggest_branch() -> str:
    return f"dolphin/{secrets.token_hex(3)}"


def valid_branch(repo: Path, name: str) -> bool:
    if not _BRANCH.match(name or ""):
        return False
    return _git(repo, "check-ref-format", "--branch", name, check=False).returncode == 0


def location(repo: Path, branch: str) -> Path:
    slug = re.sub(r"[^A-Za-z0-9._-]+", "-", branch).strip("-.") or "worktree"
    return worktrees_dir(repo) / slug


def _inside_roots(path: Path) -> bool:
    return any(path == root or root in path.parents for root in workspace_roots())


def _ignored_entries(root: Path) -> list[str]:
    """Every ignored entry, sorted (folders end in `/`). `--ignored=matching`
    lists an ignored file inside an untracked folder (apps/web/.env.local) but
    stops at a folder that is itself ignored (node_modules/)."""
    listed = _git(
        root, "status", "--porcelain=v1", "-z", "--ignored=matching", "--untracked-files=all",
        check=False,
    ).stdout
    return sorted(item[3:] for item in listed.split("\0") if item.startswith("!! "))


def _is_env_entry(entry: str) -> bool:
    return Path(entry.rstrip("/")).name.startswith(".env")


def _ignored_env_entries(root: Path) -> list[str]:
    """Every ignored entry whose name starts with `.env`, of any type or size."""
    return [entry for entry in _ignored_entries(root) if _is_env_entry(entry)]


IGNORED_NAMES_SHOWN = 5


def deleted_on_archive(worktree: Path) -> tuple[int, list[str]]:
    """The ignored entries other than `.env*` that archiving deletes (the
    `.env*` copies are checked to be unchanged instead): how many, and the
    first few names, for the Archive confirmation."""
    others = [entry for entry in _ignored_entries(Path(worktree)) if not _is_env_entry(entry)]
    return len(others), others[:IGNORED_NAMES_SHOWN]


def env_files(repo: Path) -> list[str]:
    """Ignored `.env*` files in the work tree, outside ignored folders
    (node_modules/ and the like show as one entry and are skipped)."""
    found: list[str] = []
    for name in (entry for entry in _ignored_env_entries(repo) if not entry.endswith("/")):
        relative = Path(name)
        source = repo / relative
        if not relative.name.startswith(".env") or source.is_symlink() or not source.is_file():
            continue
        if repo.resolve() not in source.resolve().parents:  # a symlinked folder on the way out
            continue
        if source.stat().st_size > ENV_FILE_MAX_BYTES:
            continue
        found.append(name)
        if len(found) >= ENV_FILE_LIMIT:
            break
    return found


def options(path: Path) -> dict:
    """What New Session can offer for this folder."""
    try:
        repo = repo_root(path)
    except WorktreeError:
        repo = None
    if repo is None or repo != Path(path).resolve():
        return {"git": False, "branch": None, "suggested_branch": suggest_branch(), "setup": False, "env_files": []}
    return {
        "git": True,
        "branch": git_repo.current_branch(repo),
        "suggested_branch": suggest_branch(),
        "setup": (repo / SETUP_PATH).is_file(),
        "env_files": env_files(repo),
    }


def create(workspace: Path, branch: str) -> CreatedWorktree:
    repo = repo_root(workspace)
    if repo != Path(workspace).resolve():
        # A project inside a repository would get worktrees beside the
        # repository, where path_in_workspace cannot tie them to the project.
        raise WorktreeError(
            f"Worktrees start from the repository's top folder, {repo}. Add that folder as a project to use them."
        )
    if not valid_branch(repo, branch):
        raise WorktreeError("That is not a valid branch name.", 422)
    path = location(repo, branch)
    if path.resolve().parent != worktrees_dir(repo).resolve():
        raise WorktreeError("That branch name does not make a usable folder name.", 422)
    if not _inside_roots(path):
        raise WorktreeError(
            f"Worktrees go in {path.parent}, which is outside the folders Dolphin may open on this machine.", 403
        )
    if not _inside_roots(path.resolve()):  # a symlinked .dolphin-worktrees
        raise WorktreeError(
            f"Worktrees go in {path.parent}, which leads to {path.resolve().parent}, "
            "outside the folders Dolphin may open on this machine.",
            403,
        )
    if path.exists():
        raise WorktreeError(f"{path} already exists.")
    if _git(repo, "rev-parse", "--verify", "--quiet", f"refs/heads/{branch}", check=False).returncode == 0:
        raise WorktreeError(f"Branch {branch} already exists.")
    head = _git(repo, "rev-parse", "--verify", "--quiet", "HEAD^{commit}", check=False)
    if head.returncode != 0:
        raise WorktreeError("This repository has no commits yet, so there is nothing to branch from.")
    base_sha = head.stdout.strip()
    base_ref = git_repo.current_branch(repo) or base_sha
    path.parent.mkdir(parents=True, exist_ok=True)
    _git(repo, "worktree", "add", "--no-track", "-b", branch, str(path), base_sha, timeout=120)
    copied: list[str] = []
    for name in env_files(repo):
        target = path / name
        # Never overwrite (a dangling symlink counts as present), and never
        # write through a symlinked folder out of the worktree.
        if os.path.lexists(target):
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        if path.resolve() not in target.parent.resolve().parents and target.parent.resolve() != path.resolve():
            continue
        shutil.copy2(repo / name, target, follow_symlinks=False)
        copied.append(name)
    return CreatedWorktree(repo, path, branch, base_ref, base_sha, copied)


def _worktree_entries(repo: Path) -> list[dict]:
    """`git worktree list --porcelain`, one dict per worktree: `path`, `head`,
    and `branch` (a full ref, or None when detached). The first is the main checkout."""
    out = _git(repo, "worktree", "list", "--porcelain").stdout
    entries: list[dict] = []
    for line in out.splitlines():
        if line.startswith("worktree "):
            entries.append({"path": Path(line[len("worktree "):]).resolve(), "head": None, "branch": None})
        elif entries and line.startswith("HEAD "):
            entries[-1]["head"] = line[len("HEAD "):].strip()
        elif entries and line.startswith("branch "):
            entries[-1]["branch"] = line[len("branch "):].strip()
    return entries


def _listed_worktrees(repo: Path) -> list[Path]:
    return [entry["path"] for entry in _worktree_entries(repo)]


def _env_files_changed(repo: Path, worktree: Path) -> bool:
    """True unless every ignored `.env*` entry in the worktree is a regular
    file that is byte-for-byte the repository's copy. Entries the copy skipped
    (too large, past the count limit, symlinks, folders) count as changed:
    `git worktree remove` would delete them, and nothing else holds them."""
    for name in _ignored_env_entries(worktree):
        if name.endswith("/"):
            return True
        copy, original = worktree / name, repo / name
        if copy.is_symlink() or not copy.is_file():
            return True
        if original.is_symlink() or not original.is_file():
            return True
        if not filecmp.cmp(original, copy, shallow=False):
            return True
    return False


def _has_initialised_submodules(worktree: Path) -> bool:
    """A submodule's own commits may exist nowhere else, and nothing here
    checks them, so a worktree with a checked-out submodule is never removed."""
    listed = _git(worktree, "ls-files", "-z", "--stage", check=False)
    if listed.returncode != 0:
        return True
    for entry in listed.stdout.split("\0"):
        if entry.startswith("160000 ") and "\t" in entry:
            if os.path.lexists(worktree / entry.split("\t", 1)[1] / ".git"):
                return True
    return False


def _location_blocker(repo: Path, worktree: Path) -> str | None:
    """Only a folder under .dolphin-worktrees that git lists as a linked
    worktree of this repository may ever be removed."""
    repo, worktree = Path(repo).resolve(), Path(worktree).resolve()
    if worktrees_dir(repo) not in worktree.parents:
        return "it is not one of Dolphin's worktrees"
    if worktree not in _listed_worktrees(repo)[1:]:  # the first entry is the main checkout
        return "git does not list it as a worktree of this repository"
    return None


def is_merged(repo: Path, branch: str, target: str) -> bool:
    if not branch or not target or branch.startswith("-") or target.startswith("-"):
        return False
    return _git(repo, "merge-base", "--is-ancestor", branch, target, check=False).returncode == 0


def removal_blocker(repo: Path, worktree: Path, branch: str, target: str) -> str | None:
    """Why this worktree may not be removed, or None when removing it loses no
    work: the checks, in order, are location (a registered worktree under
    .dolphin-worktrees), a clean `git status`, no checked-out submodule,
    unchanged `.env*` copies, the
    checked-out branch equal to `branch`, and HEAD reachable from `target`.
    Ignored files other than `.env*` are not checked; removal deletes them."""
    repo, worktree = Path(repo).resolve(), Path(worktree).resolve()
    where = _location_blocker(repo, worktree)
    if where:
        return where
    if not worktree.is_dir():
        return "its folder is missing"
    status = _git(worktree, "status", "--porcelain", "--untracked-files=all", check=False)
    if status.returncode != 0:
        return "git status failed"
    if status.stdout.strip():
        return "it has uncommitted changes"
    if _has_initialised_submodules(worktree):
        return "it has submodules; remove it by hand after checking them"
    if _env_files_changed(repo, worktree):
        return "its .env files differ from the repository's"
    # What the worktree actually has checked out, not what the caller says.
    entry = next((item for item in _worktree_entries(repo) if item["path"] == worktree), None)
    if entry is None:
        return "git does not list it as a worktree of this repository"
    if entry["branch"] is None:
        return "its HEAD is detached"
    checked_out = entry["branch"].removeprefix("refs/heads/")
    if checked_out != branch:
        return f"it has {checked_out} checked out, not {branch}"
    head = _git(worktree, "rev-parse", "--verify", "HEAD^{commit}", check=False)
    if head.returncode != 0 or not is_merged(repo, branch, target):
        return f"{branch} is not merged into {target}"
    if not is_merged(repo, head.stdout.strip(), target):
        return f"{branch} is not merged into {target}"
    return None


def archive(repo: Path, worktree: Path, branch: str, target: str) -> None:
    blocker = removal_blocker(repo, worktree, branch, target)
    if blocker:
        raise WorktreeError(f"Not archived: {blocker}.")
    # No --force: git checks again for changes. The branch stays.
    _git(Path(repo), "worktree", "remove", str(worktree), timeout=120)


def discard_unused(created: CreatedWorktree) -> bool:
    """Undo a worktree whose session never started, only while it is untouched."""
    if _location_blocker(created.repo, created.path):
        return False
    head = _git(created.path, "rev-parse", "HEAD", check=False).stdout.strip()
    status = _git(created.path, "status", "--porcelain", "--untracked-files=all", check=False)
    if head != created.base_sha or status.returncode != 0 or status.stdout.strip():
        return False
    if _env_files_changed(created.repo, created.path):
        return False
    if _git(created.repo, "worktree", "remove", str(created.path), check=False, timeout=120).returncode != 0:
        return False
    _git(created.repo, "branch", "-d", created.branch, check=False)
    return True
