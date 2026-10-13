"""Workflow endpoints (Dolphin Desktop 0.2.0, area `workflow`).

Git status, launching sessions (with a prompt, a worktree or a resumed
transcript), worktree archive, diffs, other sessions; and, in helper mode
only, listening ports, agent usage and transcript history, which read the
machine beyond the projects' folders.

Nothing here adds a login: the web install stays unauthenticated by design
(CLAUDE.md), and helper mode keeps its token gate in main.py.
"""

from __future__ import annotations

import asyncio
import os
import shlex
import time
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from . import agent_history, agent_usage, git_repo, listening_ports, session_worktrees, tmux_service
from .database import get_db
from .models import Project, SessionLink, Task
from .schemas import (
    GitStatusesResponse, GitStatusResponse, HistoryItemResponse, LaunchedWorktreeResponse, ListeningPortResponse, LaunchRequest, LaunchResponse, OtherSessionProjectResponse,
    SessionDiffResponse, SessionLinkResponse, TmuxSessionResponse, UsageResponse, WorktreeOptionsResponse, WorktreeStatusResponse,
)

router = APIRouter()

MAX_PROMPT_CHARS = 8_000


def _helper_mode() -> None:
    if not os.getenv("DOLPHIN_HELPER_VERSION"):
        raise HTTPException(status_code=404, detail="Only available in Dolphin Desktop")


def _tmux_http(error: tmux_service.TmuxServiceError) -> HTTPException:
    return HTTPException(status_code=error.status_code, detail=error.detail)


async def _project_workspace(project_id: str, db: AsyncSession) -> tuple[Project, Path]:
    project = await db.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    try:
        return project, tmux_service.require_workspace_path(project.path)
    except tmux_service.TmuxServiceError as error:
        raise _tmux_http(error) from error


# --- git status ----------------------------------------------------------------

_STATUS_TTL_SECONDS = 10.0
_FAILURE_TTL_SECONDS = 60.0
_FORGET_AFTER_SECONDS = 600.0
_CACHE_LIMIT = 256
_BUDGET_SECONDS = 8.0
_STATUS_CACHE: dict[str, tuple[float, git_repo.GitStatus | None, str | None]] = {}
# One pool for all git, shared by every request: a global cap of four
# processes that cannot starve the threads tmux calls use.
_GIT_POOL = ThreadPoolExecutor(max_workers=4, thread_name_prefix="dolphin-git")
_IN_FLIGHT: dict[str, asyncio.Future] = {}


def _now() -> float:
    return time.monotonic()


def _cached_status(path: str) -> tuple[git_repo.GitStatus | None, str | None]:
    """Successes are reused for 10 s; failures and timeouts for 60 s, so one
    huge repository costs one run a minute, not one per poll."""
    now = _now()
    hit = _STATUS_CACHE.get(path)
    if hit:
        ttl = _FAILURE_TTL_SECONDS if hit[2] else _STATUS_TTL_SECONDS
        if now - hit[0] < ttl:
            return hit[1], hit[2]
    try:
        status, error = git_repo.repo_status(Path(path)), None
    except git_repo.GitError as failure:
        status, error = None, str(failure)
    _STATUS_CACHE[path] = (_now(), status, error)
    return status, error


def _status_of(raw_path: str | None) -> tuple[git_repo.GitStatus | None, str | None]:
    """The whole blocking step, run in the git pool: resolve the folder, then
    ask git if it is an allowed directory."""
    state = tmux_service.workspace_path_status(raw_path)
    if not (state.path and state.is_directory and state.is_allowed):
        return None, None
    return _cached_status(state.path)


def _prune_cache() -> None:
    cutoff = _now() - _FORGET_AFTER_SECONDS
    for path in [p for p, entry in _STATUS_CACHE.items() if entry[0] < cutoff]:
        del _STATUS_CACHE[path]
    for path in sorted(_STATUS_CACHE, key=lambda p: _STATUS_CACHE[p][0])[: max(0, len(_STATUS_CACHE) - _CACHE_LIMIT)]:
        del _STATUS_CACHE[path]


def _single_flight(raw_path: str) -> asyncio.Future:
    """Concurrent requests for one folder await the same run of git."""
    pending = _IN_FLIGHT.get(raw_path)
    if pending is None:
        pending = asyncio.get_running_loop().run_in_executor(_GIT_POOL, _status_of, raw_path)
        _IN_FLIGHT[raw_path] = pending
        pending.add_done_callback(lambda _done: _IN_FLIGHT.pop(raw_path, None))
    return pending


def _is_merged(repo: str, branch: str | None, target: str | None) -> bool:
    if not (branch and target):
        return False
    try:
        return session_worktrees.is_merged(Path(repo), branch, target)
    except (session_worktrees.WorktreeError, OSError):
        return False


def _merged_and_deleted(repo: str, worktree: str, branch: str | None, target: str | None) -> tuple[bool, int, list[str]]:
    """Whether the branch is merged and, only then (Archive is offered), which
    ignored files archiving would delete."""
    if not _is_merged(repo, branch, target):
        return False, 0, []
    try:
        count, names = session_worktrees.deleted_on_archive(Path(worktree))
    except (session_worktrees.WorktreeError, OSError):
        return True, 0, []
    return True, count, names


async def _linked_projects(db: AsyncSession) -> list[Project]:
    """Projects with a folder that the user sees. Hidden projects (a machine's
    workspace root, for its other sessions) would match every path."""
    return list((await db.scalars(
        select(Project).where(Project.path.isnot(None), Project.is_hidden.is_(False))
    )).all())


@router.get("/api/git/status", response_model=GitStatusesResponse)
async def git_statuses(db: AsyncSession = Depends(get_db)):
    """Branch, uncommitted changes and ahead/behind for every project, in one
    request per machine. The sidebar polls it every 30 s. git runs in a shared
    pool of four threads, once per folder at a time; a repository that has not
    answered within the time budget is reported as still being checked and
    lands in the cache when it finishes."""
    projects = await _linked_projects(db)
    _prune_cache()
    runs = {project.id: _single_flight(project.path) for project in projects}
    project_paths = {project.id: project.path for project in projects}
    links = list((await db.scalars(
        select(SessionLink).where(SessionLink.worktree_path.isnot(None), SessionLink.archived_at.is_(None))
    )).all())
    links = [link for link in links if link.project_id in project_paths]
    link_runs = {link.session_name: _single_flight(link.worktree_path) for link in links}
    started = _now()
    everything = [*runs.values(), *link_runs.values()]
    if everything:
        await asyncio.wait(everything, timeout=_BUDGET_SECONDS)
    response = GitStatusesResponse(projects={project.id: None for project in projects})
    for project_id, run in runs.items():
        if not run.done():
            response.errors[project_id] = "Git is still checking this repository; it is taking a while."
            continue
        if run.exception():
            response.errors[project_id] = str(run.exception())
            continue
        status, error = run.result()
        response.projects[project_id] = GitStatusResponse(**asdict(status)) if status else None
        if error:
            response.errors[project_id] = error
    # Which worktree sessions are merged: one cheap git call each, in the same
    # pool and inside what is left of the time budget (unanswered = not merged).
    ready = [(link, link_runs[link.session_name].result()[0]) for link in links
             if link_runs[link.session_name].done() and not link_runs[link.session_name].exception()]
    ready = [(link, status) for link, status in ready if status is not None]
    loop = asyncio.get_running_loop()
    merges = [
        loop.run_in_executor(_GIT_POOL, _merged_and_deleted, project_paths[link.project_id], link.worktree_path,
                             link.branch, link.base_ref or link.base_sha)
        for link, _status in ready
    ]
    if merges:
        await asyncio.wait(merges, timeout=max(0.0, _BUDGET_SECONDS - (_now() - started)))
    for (link, status), merge in zip(ready, merges):
        merged, ignored_count, ignored_names = (
            merge.result() if merge.done() and not merge.exception() else (False, 0, []))
        response.sessions[link.session_name] = WorktreeStatusResponse(
            **asdict(status), project_id=link.project_id, worktree_path=link.worktree_path,
            base_ref=link.base_ref, merged=bool(merged),
            ignored_count=ignored_count, ignored_names=ignored_names,
        )
    return response


# --- launching sessions -------------------------------------------------------


def _session_response(info: tmux_service.TmuxSessionInfo) -> TmuxSessionResponse:
    return TmuxSessionResponse(
        name=info.name, path=info.path, created_at=info.created_at, windows=info.windows,
        attached=info.attached, current_command=info.current_command,
        is_codex_running=info.is_codex_running, is_claude_code_running=info.is_claude_code_running,
        has_recent_activity=info.has_recent_activity,
    )


def _setup_command(repo: Path) -> str | None:
    """The repository's .dolphin/setup, run from the new worktree. It is read
    from the main checkout, so an untracked setup script works too."""
    setup = repo / session_worktrees.SETUP_PATH
    if not setup.is_file():
        return None
    quoted = shlex.quote(str(setup))
    return quoted if os.access(setup, os.X_OK) else f"sh {quoted}"


@router.post("/api/projects/{project_id}/launch", response_model=LaunchResponse, status_code=201)
async def launch_session(project_id: str, body: LaunchRequest, db: AsyncSession = Depends(get_db)):
    """Start a session: an agent with a first prompt (or a todo's text), in the
    project's folder or in a new worktree on its own branch. The agent starts
    in tmux, visibly; a worktree's .dolphin/setup runs first in the same
    terminal. A session whose agent did not come up is kept and reported
    as a warning: its terminal shows why."""
    project, workspace = await _project_workspace(project_id, db)
    if body.resume:
        if body.prompt or body.task_id or body.worktree or body.mode != body.resume.agent:
            raise HTTPException(status_code=422, detail="A resumed session starts from its transcript; it takes no prompt, todo or worktree, and its mode is its agent.")
        return await _resume(project, workspace, body, db)
    task = None
    if body.task_id:
        task = await db.get(Task, body.task_id)
        if task is None or task.project_id != project.id:
            raise HTTPException(status_code=404, detail="Todo not found in this project.")
        if task.is_done:
            raise HTTPException(status_code=400, detail="Completed todos cannot be started.")
    prompt = (body.prompt or "").strip() or ((task.execution_prompt or task.title) if task else None)
    if prompt is not None:
        prompt = tmux_service.sanitize_prompt(prompt)
        if len(prompt) > MAX_PROMPT_CHARS:
            raise HTTPException(status_code=400, detail=f"The prompt is longer than {MAX_PROMPT_CHARS} characters.")
    if prompt and body.mode == "shell":
        raise HTTPException(status_code=422, detail="A shell session has no agent to give the prompt to.")

    created: session_worktrees.CreatedWorktree | None = None
    cwd = workspace
    if body.worktree:
        try:
            created = await asyncio.to_thread(session_worktrees.create, workspace, body.worktree.branch)
        except session_worktrees.WorktreeError as error:
            raise HTTPException(status_code=error.status_code, detail=error.detail) from error
        cwd = created.path
    try:
        session = await tmux_service.create_session(cwd, project.name, requested_name=body.name, mode="shell")
    except tmux_service.TmuxServiceError as error:
        if created is not None:
            await asyncio.to_thread(session_worktrees.discard_unused, created)
        raise _tmux_http(error) from error

    link = SessionLink(
        session_name=session.name, project_id=project.id, task_id=task.id if task else None,
        agent=None if body.mode == "shell" else body.mode,
        worktree_path=str(created.path) if created else None,
        branch=created.branch if created else None,
        base_ref=created.base_ref if created else None,
        base_sha=created.base_sha if created else None,
    )
    db.add(link)
    try:
        await db.commit()
    except Exception as error:
        await db.rollback()
        try:
            await tmux_service.kill_session(cwd, session.name)
        except tmux_service.TmuxServiceError:
            pass
        if created is not None:
            await asyncio.to_thread(session_worktrees.discard_unused, created)
        raise HTTPException(status_code=500, detail="Could not record the new session.") from error

    setup = _setup_command(created.repo) if created and body.worktree.run_setup else None
    warning = None
    try:
        if setup:
            # Only a path Dolphin generated is typed; the prompt rides in a file.
            line = tmux_service.prepare_agent_command(body.mode, initial_prompt=prompt, run_id=None, setup=setup)
            await tmux_service.run_in_session(cwd, session.name, line)
        elif body.mode == "claude":
            await tmux_service.start_claude(cwd, session.name, initial_prompt=prompt)
        elif body.mode == "codex":
            await tmux_service.start_codex(cwd, session.name, initial_prompt=prompt)
    except tmux_service.TmuxServiceError as error:
        warning = error.detail
    try:
        session = await tmux_service.require_workspace_session(cwd, session.name)
    except tmux_service.TmuxServiceError:
        pass
    return LaunchResponse(
        session=_session_response(session),
        worktree=LaunchedWorktreeResponse(
            path=str(created.path), branch=created.branch, base_ref=created.base_ref,
            base_sha=created.base_sha, copied=created.copied, setup=bool(setup),
        ) if created else None,
        warning=warning,
    )


@router.get("/api/projects/{project_id}/session-links", response_model=list[SessionLinkResponse])
async def session_links(project_id: str, db: AsyncSession = Depends(get_db)):
    await _project_workspace(project_id, db)
    rows = await db.scalars(
        select(SessionLink)
        .where(SessionLink.project_id == project_id, SessionLink.archived_at.is_(None))
        .order_by(SessionLink.created_at.desc())
    )
    return [SessionLinkResponse.model_validate(row) for row in rows.all()]


@router.get("/api/projects/{project_id}/worktree-options", response_model=WorktreeOptionsResponse)
async def worktree_options(project_id: str, db: AsyncSession = Depends(get_db)):
    _, workspace = await _project_workspace(project_id, db)
    return WorktreeOptionsResponse(**await asyncio.to_thread(session_worktrees.options, workspace))


@router.post("/api/projects/{project_id}/worktrees/{session_name}/archive", response_model=SessionLinkResponse)
async def archive_worktree(project_id: str, session_name: str, db: AsyncSession = Depends(get_db)):
    """Close a worktree session whose work is merged: remove its folder, then
    stop its tmux session. Refused, with the reason and nothing touched, while
    it holds anything git would lose. The branch is kept."""
    project, workspace = await _project_workspace(project_id, db)
    link = await db.get(SessionLink, session_name)
    if link is None or link.project_id != project.id or not link.worktree_path or link.archived_at is not None:
        raise HTTPException(status_code=404, detail="No open Dolphin worktree for that session.")
    worktree = Path(link.worktree_path)
    target = link.base_ref or link.base_sha
    try:
        await asyncio.get_running_loop().run_in_executor(
            _GIT_POOL, session_worktrees.archive, workspace, worktree, link.branch, target)
    except session_worktrees.WorktreeError as error:
        raise HTTPException(status_code=error.status_code, detail=error.detail) from error
    # The folder is gone and the work is safe: now stop the session, by its exact name.
    try:
        await tmux_service.kill_session(worktree, session_name)
    except tmux_service.TmuxServiceError:
        pass  # already gone, or not ours to stop; the archive itself succeeded
    link.archived_at = datetime.now(timezone.utc).replace(tzinfo=None)
    await db.commit()
    _STATUS_CACHE.pop(link.worktree_path, None)
    return SessionLinkResponse.model_validate(link)


# --- diff ------------------------------------------------------------------------

_DIFF_FLIGHT: dict[tuple, asyncio.Future] = {}


def _diff_single_flight(path: str, sha: str | None, ref: str | None) -> asyncio.Future:
    """Concurrent requests for the same diff share one run of git, in the git pool."""
    key = (path, sha, ref)
    pending = _DIFF_FLIGHT.get(key)
    if pending is None:
        pending = asyncio.get_running_loop().run_in_executor(
            _GIT_POOL, git_repo.session_diff, Path(path), sha, ref)
        _DIFF_FLIGHT[key] = pending
        pending.add_done_callback(lambda _done: _DIFF_FLIGHT.pop(key, None))
    return pending


@router.get("/api/projects/{project_id}/tmux/sessions/{session_name}/diff", response_model=SessionDiffResponse)
async def session_diff(project_id: str, session_name: str, db: AsyncSession = Depends(get_db)):
    """The session's changes against its base. Read-only; 404 outside a repository."""
    project, workspace = await _project_workspace(project_id, db)
    try:
        session = await tmux_service.require_workspace_session(workspace, session_name)
    except tmux_service.TmuxServiceError as error:
        raise _tmux_http(error) from error
    link = await db.get(SessionLink, session_name)
    if link is not None and link.project_id != project.id:
        link = None
    for candidate in dict.fromkeys((session.path, *(session.pane_paths or ()))):
        try:
            diff = await _diff_single_flight(
                candidate, link.base_sha if link else None, link.base_ref if link else None)
        except git_repo.GitError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        if diff is not None:
            return SessionDiffResponse(**asdict(diff))
    raise HTTPException(status_code=404, detail="This session is not working in a git repository.")


# --- ports (helper mode) ----------------------------------------------------------


@router.get("/api/desktop/ports", response_model=list[ListeningPortResponse])
async def desktop_ports(db: AsyncSession = Depends(get_db)):
    """What this machine's user is serving, each with the project its process
    runs in, for "Open on this computer"."""
    _helper_mode()
    found = await asyncio.to_thread(listening_ports.list_ports)
    folders = []
    for project in await _linked_projects(db):
        state = tmux_service.workspace_path_status(project.path)
        if state.path and state.is_directory:
            folders.append((project, Path(state.path)))
    rows = []
    for port in found:
        owner = None
        if port.cwd:
            cwd = Path(port.cwd)
            owner = next((project for project, path in folders if tmux_service.path_in_workspace(cwd, path)), None)
        rows.append(ListeningPortResponse(
            **asdict(port), project_id=owner.id if owner else None, project_name=owner.name if owner else None,
        ))
    return rows


# --- usage (helper mode) ------------------------------------------------------------

_USAGE_TTL_SECONDS = 60.0
_USAGE_CACHE: dict[str, tuple[float, dict]] = {}


@router.get("/api/desktop/usage", response_model=UsageResponse)
async def desktop_usage():
    """Claude and Codex tokens on this machine: the current 5-hour window, the
    last 7 days, the burn rate, and Codex's own reported limits."""
    _helper_mode()
    home = str(Path.home())
    hit = _USAGE_CACHE.get(home)
    if hit and time.monotonic() - hit[0] < _USAGE_TTL_SECONDS:
        return hit[1]
    report = await asyncio.to_thread(agent_usage.collect, Path(home))
    _USAGE_CACHE[home] = (time.monotonic(), report)
    return report


async def _resume(project: Project, workspace: Path, body: LaunchRequest, db: AsyncSession) -> LaunchResponse:
    """`claude --resume <id>` or `codex resume <id>` in a new tmux session, in
    the folder the transcript was recorded in. Transcripts are read from this
    machine's home, so this is helper mode only. The id reaches the shell only
    inside the same fixed-text launcher a prompt uses."""
    _helper_mode()
    resume = body.resume
    found = await asyncio.to_thread(agent_history.find, Path.home(), workspace, resume.agent, resume.id)
    if found is None:
        raise HTTPException(status_code=404, detail="That transcript is not in this project's history.")
    cwd = Path(found.cwd).resolve()
    if not cwd.is_dir() or not tmux_service.path_in_workspace(cwd, workspace):
        cwd = workspace
    try:
        line = await asyncio.to_thread(
            tmux_service.prepare_agent_command, resume.agent, initial_prompt=None, run_id=None, resume_id=resume.id)
        session = await tmux_service.create_session(cwd, project.name, requested_name=body.name, mode="shell")
    except tmux_service.TmuxServiceError as error:
        raise _tmux_http(error) from error
    db.add(SessionLink(session_name=session.name, project_id=project.id, agent=resume.agent))
    await db.commit()
    warning = None
    try:
        await tmux_service.run_in_session(cwd, session.name, line)
    except tmux_service.TmuxServiceError as error:
        warning = error.detail
    return LaunchResponse(session=_session_response(session), warning=warning)


# --- history (helper mode) ---------------------------------------------------------


@router.get("/api/desktop/history", response_model=list[HistoryItemResponse])
async def desktop_history(project_id: str, q: str = "", db: AsyncSession = Depends(get_db)):
    """This project's Claude and Codex transcripts on this machine, newest first,
    optionally only those mentioning `q`."""
    _helper_mode()
    _, workspace = await _project_workspace(project_id, db)
    return await asyncio.to_thread(agent_history.search, Path.home(), workspace, q[:200])


_HIDDEN_ROOT_LOCK = asyncio.Lock()


# --- other sessions -----------------------------------------------------------------


@router.post("/api/tmux/other-sessions/{session_name}/open", response_model=OtherSessionProjectResponse)
async def open_other_session(session_name: str, db: AsyncSession = Depends(get_db)):
    """The project to open a session outside every project through: a hidden
    project for the workspace root it works in, made on first use. Every
    terminal endpoint is per project; this keeps them that way. It never
    kills, renames or moves the session."""
    try:
        sessions = await tmux_service.list_all_sessions()
    except tmux_service.TmuxServiceError as error:
        raise _tmux_http(error) from error
    session = next((item for item in sessions if item.name == session_name), None)
    if session is None:
        raise HTTPException(status_code=404, detail="That tmux session is no longer available.")
    paths = [Path(raw).expanduser().resolve() for raw in (session.path, *(session.pane_paths or ()))]
    root = next((root for root in tmux_service.workspace_roots() if any(p == root or root in p.parents for p in paths)), None)
    if root is None:
        raise HTTPException(status_code=403, detail="This session runs outside the folders Dolphin may open.")
    async with _HIDDEN_ROOT_LOCK:
        hidden = select(Project).where(Project.is_hidden.is_(True), Project.path == str(root))
        project = await db.scalar(hidden.order_by(Project.id))
        if project is None:
            db.add(Project(name="Other sessions", path=str(root), is_hidden=True, position=0))
            await db.commit()
            # Another process could have made one too: the lowest id wins.
            project = await db.scalar(hidden.order_by(Project.id))
    return OtherSessionProjectResponse(project_id=project.id, project_name=project.name)
