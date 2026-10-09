"""HTTP contracts for Dolphin chat threads.

The tables keep their historical ``chief_*`` names. Threads created before the
Chief turn service was removed may still carry a moment or project snapshot;
responses expose those fields read-only, and new threads never set them.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from .chief_conversation_repository import ChiefMessageRecord, ChiefThreadRecord


class ChiefThreadCreate(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")

    title: str = Field(min_length=1, max_length=80)


class ChiefThreadPatch(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")

    title: str = Field(min_length=1, max_length=80)


class ChiefUserTurnRequest(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")

    text: str = Field(min_length=1, max_length=4_000)


class ChiefMessageResponse(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")

    id: str
    thread_id: str
    role: Literal["user", "assistant"]
    kind: Literal["text", "response"]
    text: str
    payload: dict[str, Any]
    in_reply_to_message_id: str | None
    created_at: datetime


class ChiefThreadResponse(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")

    id: str
    title: str
    moment_fingerprint: str | None
    moment_snapshot: dict[str, Any] | None
    moment_snapshot_hash: str | None
    project_snapshot_key: str | None
    project_snapshot: dict[str, Any] | None
    project_snapshot_hash: str | None
    created_at: datetime
    updated_at: datetime
    version: int


class ChiefThreadDetailResponse(ChiefThreadResponse):
    messages: list[ChiefMessageResponse]
    pending_idempotency_keys: list[str] = Field(max_length=100)


def thread_response(record: ChiefThreadRecord) -> ChiefThreadResponse:
    return ChiefThreadResponse(
        id=record.id,
        title=record.title,
        moment_fingerprint=record.moment_fingerprint,
        moment_snapshot=record.moment_snapshot,
        moment_snapshot_hash=record.moment_snapshot_hash,
        project_snapshot_key=record.project_snapshot_key,
        project_snapshot=record.project_snapshot,
        project_snapshot_hash=record.project_snapshot_hash,
        created_at=record.created_at,
        updated_at=record.updated_at,
        version=record.version,
    )


def message_response(record: ChiefMessageRecord) -> ChiefMessageResponse:
    return ChiefMessageResponse(
        id=record.id,
        thread_id=record.thread_id,
        role=record.role,
        kind=record.kind,
        text=record.text,
        payload=record.payload,
        in_reply_to_message_id=record.in_reply_to_message_id,
        created_at=record.created_at,
    )
