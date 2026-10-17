"""Dolphin's memory (app/brain.py): its setup state, a way to retry setup, and
the two ends of bringing every machine's work home (app/brain_sync.py)."""

from __future__ import annotations

import asyncio
import json
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.ext.asyncio import AsyncSession

from . import brain, brain_sync
from .database import get_db

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


# --- bringing every machine's work home (app/brain_sync.py) ---------------------


@router.get("/api/brain/export")
async def export_for_sync(cursor: str = "", db: AsyncSession = Depends(get_db)):
    """What this machine knows past `cursor` (the last export's `cursor`, as JSON)."""
    try:
        position = json.loads(cursor) if cursor else {}
    except ValueError:
        raise HTTPException(status_code=400, detail="cursor is not JSON")
    if not isinstance(position, dict):
        raise HTTPException(status_code=400, detail="cursor is not an object")
    return await brain_sync.export(db, position)


class SyncMachine(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(min_length=1, max_length=200)
    label: str = Field(default="", max_length=200)
    kind: Literal["local", "ssh"] = "ssh"


class SyncImport(BaseModel):
    model_config = ConfigDict(extra="forbid")
    machine: SyncMachine
    export: dict


@router.post("/api/brain/import")
async def import_from_machine(body: SyncImport):
    """One machine's export, into this machine's brain. 409 while memory is off here."""
    if not brain.ready():
        raise HTTPException(status_code=409, detail="Memory is not on for this computer.")
    return await asyncio.to_thread(brain_sync.receive, body.machine.model_dump(), body.export)
