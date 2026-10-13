"""Dolphin's memory (app/brain.py): its setup state, and a way to retry setup."""

from __future__ import annotations

import asyncio

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict

from . import brain

router = APIRouter()


@router.get("/api/brain")
async def brain_status():
    return await asyncio.to_thread(brain.status)


@router.post("/api/brain/setup")
async def set_up_brain():
    """Start (or retry) setting up this machine's brain. Returns at once; poll GET."""
    return await asyncio.to_thread(brain.start_install, True)


class MemoryChoice(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")
    enabled: bool


@router.post("/api/brain/consent")
async def choose_memory(body: MemoryChoice):
    """The user turned memory on or off in Dolphin Desktop. Returns at once; poll GET."""
    return await asyncio.to_thread(brain.set_consent, body.enabled)
