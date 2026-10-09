"""Dolphin's memory (app/brain.py): its setup state, and a way to retry setup."""

from __future__ import annotations

import asyncio

from fastapi import APIRouter

from . import brain

router = APIRouter()


@router.get("/api/brain")
async def brain_status():
    return await asyncio.to_thread(brain.status)


@router.post("/api/brain/setup")
async def set_up_brain():
    """Start (or retry) setting up this machine's brain. Returns at once; poll GET."""
    return await asyncio.to_thread(brain.start_install, True)
