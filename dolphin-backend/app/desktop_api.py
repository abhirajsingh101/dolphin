"""Endpoints only Dolphin Desktop's workspace uses."""

from __future__ import annotations

import asyncio
import os
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from . import agent_clis, agent_hooks_setup, agent_memory_setup, recent_repos, tmux_projects
from .database import get_db
from .models import Project

router = APIRouter()


class HooksRequest(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")
    agents: list[Literal["claude", "codex"]]


def _helper_mode() -> None:
    if not os.getenv("DOLPHIN_HELPER_VERSION"):
        raise HTTPException(status_code=404, detail="Only available in Dolphin Desktop")


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
    linked = {path for path in (await db.scalars(select(Project.path))).all() if path}
    return await asyncio.to_thread(recent_repos.find, 6, linked)


@router.post("/api/desktop/tmux-projects")
async def import_tmux_projects(db: AsyncSession = Depends(get_db)):
    """Make projects of the folders this machine's tmux sessions run in, once
    per folder, so connecting shows the work already going on there."""
    _helper_mode()
    # Tests that run against the user's own tmux server turn this off, so
    # their scratch databases never fill with the user's real projects.
    if os.getenv("DOLPHIN_TMUX_IMPORT") == "off":
        return {"added": []}
    from .tmux_service import TmuxServiceError, list_all_sessions

    try:
        sessions = await list_all_sessions()
    except TmuxServiceError:
        return {"added": []}
    linked = [path for path in (await db.scalars(select(Project.path))).all() if path]
    seen = tmux_projects.imported()
    found = tmux_projects.plan(sessions, linked, seen)
    if not found:
        return {"added": []}
    position = await db.scalar(select(func.count(Project.id))) or 0
    added = []
    for offset, (path, names) in enumerate(sorted(found.items(), key=lambda item: item[0].rsplit("/", 1)[-1].lower())):
        project = Project(name=path.rstrip("/").split("/")[-1], path=path, position=position + offset)
        db.add(project)
        added.append((project, names))
    await db.commit()
    tmux_projects.remember(seen | set(found))
    return {"added": [{"id": project.id, "name": project.name, "path": project.path, "sessions": names} for project, names in added]}


@router.get("/api/desktop/agent-memory")
async def agent_memory_status():
    _helper_mode()
    return await asyncio.to_thread(agent_memory_setup.status)


@router.post("/api/desktop/agent-memory")
async def connect_agent_memory(body: HooksRequest):
    """Register Dolphin's memory with the chosen agents (their own `mcp add`)."""
    _helper_mode()
    try:
        return await asyncio.to_thread(agent_memory_setup.connect, list(body.agents))
    except (ValueError, RuntimeError, OSError) as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
