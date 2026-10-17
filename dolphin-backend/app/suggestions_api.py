"""Skill and plugin suggestions (app/skill_suggestions.py) for the nudge above the chat.

Nothing here installs anything: each item carries a link and the command the
user may run themselves."""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from . import skill_suggestions

router = APIRouter()


@router.get("/api/suggestions/skills")
async def list_suggestions():
    """{"enabled", "items", "generated_at"}; never an error, empty while memory is off."""
    return await asyncio.to_thread(skill_suggestions.view)


class DismissBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    key: str = Field(min_length=1, max_length=500)


@router.post("/api/suggestions/skills/dismiss", status_code=204)
async def dismiss_suggestion(body: DismissBody):
    await asyncio.to_thread(skill_suggestions.dismiss, body.key)
    return Response(status_code=204)


@router.post("/api/suggestions/skills/refresh", status_code=202)
async def refresh_suggestions():
    """Start a run now. started is false while one runs, after a 429, or when off."""
    return JSONResponse(status_code=202, content={"started": skill_suggestions.refresh()})


class EnabledBody(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")
    enabled: bool


@router.put("/api/suggestions/skills/enabled")
async def set_suggestions_enabled(body: EnabledBody):
    return {"enabled": await asyncio.to_thread(skill_suggestions.set_enabled, body.enabled)}
