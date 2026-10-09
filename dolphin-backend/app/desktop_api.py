"""Endpoints only Dolphin Desktop's workspace uses."""

from __future__ import annotations

import asyncio
import os
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from . import agent_clis, agent_hooks_setup, agent_memory_setup, recent_repos
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
