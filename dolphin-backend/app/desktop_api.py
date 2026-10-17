"""Endpoints only Dolphin Desktop's workspace uses."""

from __future__ import annotations

import asyncio
import os
from typing import Literal, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Response
from pydantic import BaseModel, ConfigDict
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from . import agent_clis, agent_hooks_setup, desktop_environment, recent_repos, tmux_projects, turn_notifications
from .database import get_db
from .models import Project

router = APIRouter()


class HooksRequest(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")
    agents: list[Literal["claude", "codex"]]


AUTO_IMPORT_LIMIT = 5
# Overlapping imports (the 60 s poll, a dialog answer) would each read the
# remembered folders before the other wrote them. One at a time.
_import_lock = asyncio.Lock()


class ImportRequest(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")
    paths: list[str]
    # The folders the dialog showed. Only these (and the chosen ones) are
    # remembered, so a folder that appeared while it was open is still offered.
    offered: Optional[list[str]] = None


def _helper_mode() -> None:
    if not os.getenv("DOLPHIN_HELPER_VERSION"):
        raise HTTPException(status_code=404, detail="Only available in Dolphin Desktop")


@router.post("/api/desktop/turn-nudge", status_code=204)
async def turn_nudge():
    """Dolphin's hook, after it records a turn change on its pane: look now.
    The request carries nothing; tmux stays the source of truth."""
    _helper_mode()
    turn_notifications.wake()
    return Response(status_code=204)


@router.get("/api/desktop/agent-hooks")
async def agent_hooks_status():
    _helper_mode()
    return await asyncio.to_thread(agent_hooks_setup.status)


@router.post("/api/desktop/agent-hooks")
async def install_agent_hooks(body: HooksRequest):
    _helper_mode()
    try:
        return await asyncio.to_thread(agent_hooks_setup.install, list(body.agents))
    except (ValueError, FileNotFoundError, OSError) as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


@router.get("/api/desktop/agents")
async def agent_clis_status(refresh: bool = False):
    _helper_mode()
    return await asyncio.to_thread(agent_clis.status, refresh)


@router.get("/api/desktop/recent-repos")
async def recent_git_repos(db: AsyncSession = Depends(get_db)):
    """Git repositories under the workspace roots, most recently used first,
    leaving out folders that are already projects."""
    _helper_mode()
    linked = {path for path in (await db.scalars(select(Project.path).where(Project.is_hidden.is_(False)))).all() if path}
    return await asyncio.to_thread(recent_repos.find, 6, linked)


@router.post("/api/desktop/tmux-projects")
async def import_tmux_projects(
    body: Optional[ImportRequest] = Body(default=None),
    dry_run: bool = False,
    db: AsyncSession = Depends(get_db),
):
    _helper_mode()
    async with _import_lock:
        return await _import_tmux_projects(body, dry_run, db)


async def _import_tmux_projects(body: Optional[ImportRequest], dry_run: bool, db: AsyncSession):
    """Make projects of the folders this machine's tmux sessions run in, once
    per folder, so connecting shows the work already going on there.

    Up to AUTO_IMPORT_LIMIT new folders are added at once. More are returned
    as `pending` and nothing is written until a call with `paths` names the
    ones to add. Every folder the dialog showed (`offered`) is remembered, so
    the ones not chosen are not offered again; folders that appeared since
    stay pending."""
    _helper_mode()
    # Tests that run against the user's own tmux server turn this off, so
    # their scratch databases never fill with the user's real projects.
    if os.getenv("DOLPHIN_TMUX_IMPORT") == "off":
        return {"added": [], "pending": []}
    from .tmux_service import TmuxServiceError, list_all_sessions

    try:
        sessions = await list_all_sessions()
    except TmuxServiceError:
        return {"added": [], "pending": []}
    linked = [path for path in (await db.scalars(select(Project.path).where(Project.is_hidden.is_(False)))).all() if path]
    seen = tmux_projects.imported()
    found = tmux_projects.plan(sessions, linked, seen)
    if not found:
        return {"added": [], "pending": []}
    name_of = lambda path: path.rstrip("/").split("/")[-1]  # noqa: E731
    ordered = sorted(found.items(), key=lambda item: name_of(item[0]).lower())
    pending = [{"path": path, "name": name_of(path), "sessions": names} for path, names in ordered]
    if dry_run or (body is None and len(found) > AUTO_IMPORT_LIMIT):
        return {"added": [], "pending": pending}
    wanted = set(found) if body is None else set(body.paths) & set(found)
    # Immediately before inserting: a project made some other way meanwhile
    # (the picker, a second window) is not made again.
    wanted -= set((await db.scalars(select(Project.path).where(Project.path.in_(wanted)))).all())
    position = await db.scalar(select(func.count(Project.id))) or 0
    added = []
    for offset, (path, names) in enumerate((path, names) for path, names in ordered if path in wanted):
        project = Project(name=name_of(path), path=path, position=position + offset)
        db.add(project)
        added.append((project, names))
    await db.commit()
    if body is None or body.offered is None:
        answered = set(found)  # added without asking, or an older client
    else:
        answered = set(body.offered) | (set(body.paths) & set(found))
    tmux_projects.remember(seen | answered)
    return {
        "added": [{"id": project.id, "name": project.name, "path": project.path, "sessions": names} for project, names in added],
        "pending": [],
    }


@router.get("/api/desktop/environment")
async def machine_environment():
    """tmux, the helper's version and agent sign-ins, for the first-run
    checklist and Help → Report an Issue…."""
    _helper_mode()
    return await asyncio.to_thread(desktop_environment.snapshot)
