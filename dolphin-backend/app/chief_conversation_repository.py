"""Persistence for Dolphin chat threads, messages and turn idempotency.

The tables keep their historical ``chief_*`` names. Moment and project
snapshots are only ever read, for threads created before those origins were
removed. Conversation history is bounded operational context in Dolphin
SQLite; it is never canonical memory.
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Literal

from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from .models import (
    ChiefMessage,
    ChiefMomentSnapshot,
    ChiefProjectSnapshot,
    ChiefThread,
    ChiefTurnRequest,
    generate_id,
)


MAX_TITLE_LENGTH = 80
MAX_USER_TEXT_LENGTH = 4_000
MAX_RESPONSE_BYTES = 256 * 1024
MAX_RECENT_MESSAGES = 8
MAX_RECENT_CHARACTERS = 12_000


class ChiefConversationNotFound(RuntimeError):
    """Sanitized ownership/not-found result safe to translate to HTTP 404."""

    def __init__(self) -> None:
        super().__init__("Chief conversation not found")


class ChiefConversationConflict(RuntimeError):
    """Sanitized concurrent-change result safe to expose as a typed conflict."""


@dataclass(frozen=True)
class ChiefThreadRecord:
    id: str
    title: str
    moment_fingerprint: str | None
    moment_snapshot: dict[str, Any] | None
    moment_snapshot_hash: str | None
    created_at: datetime
    updated_at: datetime
    version: int
    project_fingerprint: str | None = None
    project_snapshot_key: str | None = None
    project_snapshot: dict[str, Any] | None = None
    project_snapshot_hash: str | None = None


@dataclass(frozen=True)
class ChiefMessageRecord:
    id: str
    thread_id: str
    role: Literal["user", "assistant"]
    kind: Literal["text", "response"]
    text: str
    payload: dict[str, Any]
    in_reply_to_message_id: str | None
    created_at: datetime


@dataclass(frozen=True)
class ChiefTurnRecord:
    status: Literal[
        "pending",
        "in_progress",
        "completed",
        "failed",
        "timed_out",
        "cancelled",
    ]
    turn_request_id: str
    user_message_id: str
    assistant_message_id: str | None
    response_bytes: bytes | None
    should_generate: bool


def _now(value: datetime | None) -> datetime:
    return value or datetime.now(timezone.utc)


def _public_datetime(value: datetime) -> datetime:
    """Return stable UTC-aware timestamps before and after SQLite reloads."""

    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _canonical_json(value: object) -> str:
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    )


def _copy_bytes(value: bytes | None) -> bytes | None:
    if value is None:
        return None
    # ``bytes(existing_bytes)`` may return the identical object.  A durable
    # replay is intentionally an independent value owned by the repository.
    return bytes(bytearray(value))


def _validate_title(title: str) -> None:
    if not isinstance(title, str) or title != title.strip() or not (
        1 <= len(title) <= MAX_TITLE_LENGTH
    ):
        raise ValueError("title must contain 1..80 normalized characters")


def _normalize_idempotency_key(value: str) -> str:
    try:
        parsed = uuid.UUID(value)
    except (AttributeError, TypeError, ValueError) as exc:
        raise ValueError("idempotency key must be a UUID") from exc
    normalized = str(parsed)
    if len(normalized) != 36:
        raise ValueError("idempotency key must be a UUID")
    return normalized


def _decode_object(raw: str) -> dict[str, Any]:
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise ChiefConversationConflict("stored conversation payload is invalid")
    return value


class ChiefConversationRepository:
    """Short-transaction CRUD with durable per-thread idempotency."""

    def __init__(self, session: AsyncSession) -> None:
        self._db = session

    async def create_thread(
        self,
        *,
        title: str,
        now: datetime | None = None,
    ) -> ChiefThreadRecord:
        _validate_title(title)
        timestamp = _now(now)
        thread = ChiefThread(
            id=generate_id(),
            title=title,
            created_at=timestamp,
            updated_at=timestamp,
            version=1,
        )
        self._db.add(thread)
        await self._db.commit()
        return await self.get_thread(thread.id)

    @staticmethod
    def _thread_record(
        thread: ChiefThread,
        snapshot: ChiefMomentSnapshot | None,
        project_snapshot: ChiefProjectSnapshot | None,
    ) -> ChiefThreadRecord:
        project_snapshot_value = (
            None
            if project_snapshot is None
            else _decode_object(project_snapshot.snapshot_json)
        )
        return ChiefThreadRecord(
            id=thread.id,
            title=thread.title,
            moment_fingerprint=thread.moment_fingerprint,
            moment_snapshot=(
                None if snapshot is None else _decode_object(snapshot.snapshot_json)
            ),
            moment_snapshot_hash=(None if snapshot is None else snapshot.snapshot_hash),
            project_fingerprint=thread.project_fingerprint,
            project_snapshot_key=(
                None
                if project_snapshot_value is None
                else project_snapshot_value.get("project_key")
            ),
            project_snapshot=project_snapshot_value,
            project_snapshot_hash=(
                None if project_snapshot is None else project_snapshot.snapshot_hash
            ),
            created_at=_public_datetime(thread.created_at),
            updated_at=_public_datetime(thread.updated_at),
            version=thread.version,
        )

    async def get_thread(self, thread_id: str) -> ChiefThreadRecord:
        result = await self._db.execute(
            select(ChiefThread, ChiefMomentSnapshot, ChiefProjectSnapshot)
            .outerjoin(
                ChiefMomentSnapshot,
                ChiefMomentSnapshot.thread_id == ChiefThread.id,
            )
            .outerjoin(
                ChiefProjectSnapshot,
                ChiefProjectSnapshot.thread_id == ChiefThread.id,
            )
            .where(ChiefThread.id == thread_id)
        )
        row = result.one_or_none()
        if row is None:
            raise ChiefConversationNotFound()
        return self._thread_record(row[0], row[1], row[2])

    async def list_threads(self, *, limit: int = 100) -> list[ChiefThreadRecord]:
        if not isinstance(limit, int) or isinstance(limit, bool) or not (
            1 <= limit <= 100
        ):
            raise ValueError("thread list limit must be 1..100")
        result = await self._db.execute(
            select(ChiefThread, ChiefMomentSnapshot, ChiefProjectSnapshot)
            .outerjoin(
                ChiefMomentSnapshot,
                ChiefMomentSnapshot.thread_id == ChiefThread.id,
            )
            .outerjoin(
                ChiefProjectSnapshot,
                ChiefProjectSnapshot.thread_id == ChiefThread.id,
            )
            .order_by(
                ChiefThread.updated_at.desc(),
                ChiefThread.created_at.desc(),
                ChiefThread.id.desc(),
            )
            .limit(limit)
        )
        return [self._thread_record(row[0], row[1], row[2]) for row in result.all()]

    async def rename_thread(
        self,
        thread_id: str,
        title: str,
        *,
        now: datetime | None = None,
    ) -> ChiefThreadRecord:
        _validate_title(title)
        thread = await self._load_thread(thread_id)
        thread.title = title
        thread.updated_at = _now(now)
        thread.version += 1
        await self._db.commit()
        return await self.get_thread(thread_id)

    async def delete_thread(self, thread_id: str) -> bool:
        await self._load_thread(thread_id)
        result = await self._db.execute(
            delete(ChiefThread).where(ChiefThread.id == thread_id)
        )
        await self._db.commit()
        return bool(result.rowcount)

    async def _load_thread(self, thread_id: str) -> ChiefThread:
        result = await self._db.execute(
            select(ChiefThread).where(ChiefThread.id == thread_id)
        )
        thread = result.scalar_one_or_none()
        if thread is None:
            raise ChiefConversationNotFound()
        return thread

    async def begin_turn(
        self,
        thread_id: str,
        *,
        idempotency_key: str,
        user_text: str,
        now: datetime | None = None,
    ) -> ChiefTurnRecord:
        key = _normalize_idempotency_key(idempotency_key)
        if not isinstance(user_text, str) or not user_text.strip() or len(
            user_text
        ) > MAX_USER_TEXT_LENGTH:
            raise ValueError("user text must be 1..4000 characters")

        thread = await self._load_thread(thread_id)
        existing = await self._find_turn(thread_id, key)
        if existing is not None:
            return self._turn_record(existing, duplicate=True)

        timestamp = _now(now)
        message = ChiefMessage(
            id=generate_id(),
            thread_id=thread_id,
            role="user",
            kind="text",
            text=user_text,
            payload_json="{}",
            in_reply_to_message_id=None,
            created_at=timestamp,
        )
        request = ChiefTurnRequest(
            id=generate_id(),
            thread_id=thread_id,
            idempotency_key=key,
            user_message_id=message.id,
            assistant_message_id=None,
            status="pending",
            attempt_count=0,
            response_bytes=None,
            error_code=None,
            created_at=timestamp,
            updated_at=timestamp,
        )
        self._db.add(message)
        try:
            await self._db.flush()
            self._db.add(request)
            thread.updated_at = timestamp
            thread.version += 1
            await self._db.commit()
        except IntegrityError:
            await self._db.rollback()
            existing = await self._find_turn(thread_id, key)
            if existing is None:
                raise ChiefConversationConflict("Chief turn could not be accepted")
            return self._turn_record(existing, duplicate=True)
        return self._turn_record(request, duplicate=False)

    async def _find_turn(
        self,
        thread_id: str,
        idempotency_key: str,
    ) -> ChiefTurnRequest | None:
        result = await self._db.execute(
            select(ChiefTurnRequest).where(
                ChiefTurnRequest.thread_id == thread_id,
                ChiefTurnRequest.idempotency_key == idempotency_key,
            )
        )
        return result.scalar_one_or_none()

    async def get_turn(
        self,
        thread_id: str,
        idempotency_key: str,
    ) -> ChiefTurnRecord:
        key = _normalize_idempotency_key(idempotency_key)
        request = await self._find_turn(thread_id, key)
        if request is None:
            raise ChiefConversationNotFound()
        return self._turn_record(request, duplicate=True)

    @staticmethod
    def _turn_record(
        request: ChiefTurnRequest,
        *,
        duplicate: bool,
    ) -> ChiefTurnRecord:
        public_status = (
            "in_progress"
            if duplicate and request.status == "pending"
            else request.status
        )
        return ChiefTurnRecord(
            status=public_status,
            turn_request_id=request.id,
            user_message_id=request.user_message_id,
            assistant_message_id=request.assistant_message_id,
            response_bytes=_copy_bytes(request.response_bytes),
            should_generate=(not duplicate and request.status == "pending"),
        )

    async def complete_turn(
        self,
        thread_id: str,
        turn_request_id: str,
        *,
        assistant_payload: dict[str, Any],
        response_bytes: bytes,
        now: datetime | None = None,
    ) -> ChiefTurnRecord:
        await self._load_thread(thread_id)
        result = await self._db.execute(
            select(ChiefTurnRequest).where(
                ChiefTurnRequest.id == turn_request_id,
                ChiefTurnRequest.thread_id == thread_id,
            )
        )
        request = result.scalar_one_or_none()
        if request is None:
            raise ChiefConversationNotFound()
        if request.status == "completed":
            return self._turn_record(request, duplicate=True)
        if request.status != "pending":
            raise ChiefConversationConflict("Chief turn is no longer pending")
        if not isinstance(assistant_payload, dict):
            raise ValueError("assistant payload must be an object")
        if not isinstance(response_bytes, bytes) or not (
            1 <= len(response_bytes) <= MAX_RESPONSE_BYTES
        ):
            raise ValueError("assistant response must be 1..256 KiB")
        display_text = assistant_payload.get("display_text")
        if not isinstance(display_text, str) or not display_text.strip() or len(
            display_text
        ) > 12_000:
            raise ValueError("assistant display text is invalid")
        payload_json = _canonical_json(assistant_payload)
        if len(payload_json.encode("utf-8")) > MAX_RESPONSE_BYTES:
            raise ValueError("assistant payload exceeds 256 KiB")

        desired_id = assistant_payload.get("assistant_message_id")
        assistant_id = (
            desired_id
            if isinstance(desired_id, str) and 1 <= len(desired_id) <= 128
            else generate_id()
        )
        timestamp = _now(now)
        assistant = ChiefMessage(
            id=assistant_id,
            thread_id=thread_id,
            role="assistant",
            kind="response",
            text=display_text,
            payload_json=payload_json,
            in_reply_to_message_id=request.user_message_id,
            created_at=timestamp,
        )
        self._db.add(assistant)
        try:
            await self._db.flush()
            request.assistant_message_id = assistant.id
            request.status = "completed"
            request.response_bytes = _copy_bytes(response_bytes)
            request.error_code = None
            request.updated_at = timestamp
            thread = await self._load_thread(thread_id)
            thread.updated_at = timestamp
            thread.version += 1
            await self._db.commit()
        except IntegrityError as exc:
            await self._db.rollback()
            replay = await self._load_turn(thread_id, turn_request_id)
            if replay.status == "completed":
                return self._turn_record(replay, duplicate=True)
            raise ChiefConversationConflict("Chief turn completion conflicted") from exc
        return self._turn_record(request, duplicate=False)

    async def _load_turn(
        self,
        thread_id: str,
        turn_request_id: str,
    ) -> ChiefTurnRequest:
        result = await self._db.execute(
            select(ChiefTurnRequest).where(
                ChiefTurnRequest.id == turn_request_id,
                ChiefTurnRequest.thread_id == thread_id,
            )
        )
        request = result.scalar_one_or_none()
        if request is None:
            raise ChiefConversationNotFound()
        return request

    async def mark_turn_failed(
        self,
        thread_id: str,
        turn_request_id: str,
        *,
        status: Literal["failed", "timed_out", "cancelled"],
        error_code: str,
        now: datetime | None = None,
    ) -> ChiefTurnRecord:
        if status not in {"failed", "timed_out", "cancelled"}:
            raise ValueError("invalid failed turn status")
        request = await self._load_turn(thread_id, turn_request_id)
        if request.status == "completed":
            return self._turn_record(request, duplicate=True)
        if request.status != "pending":
            return self._turn_record(request, duplicate=True)
        request.status = status
        request.error_code = error_code[:120]
        request.updated_at = _now(now)
        await self._db.commit()
        return self._turn_record(request, duplicate=False)

    async def list_messages(
        self,
        thread_id: str,
        *,
        limit: int = 100,
    ) -> list[ChiefMessageRecord]:
        if not isinstance(limit, int) or isinstance(limit, bool) or not (
            1 <= limit <= 100
        ):
            raise ValueError("message list limit must be 1..100")
        await self._load_thread(thread_id)
        result = await self._db.execute(
            select(ChiefMessage)
            .where(ChiefMessage.thread_id == thread_id)
            .order_by(ChiefMessage.created_at.desc(), ChiefMessage.id.desc())
            .limit(limit)
        )
        newest_first = list(result.scalars().all())
        return [self._message_record(row) for row in reversed(newest_first)]

    async def list_pending_idempotency_keys(self, thread_id: str) -> list[str]:
        await self._load_thread(thread_id)
        result = await self._db.execute(
            select(ChiefTurnRequest.idempotency_key)
            .where(
                ChiefTurnRequest.thread_id == thread_id,
                ChiefTurnRequest.status == "pending",
            )
            .order_by(ChiefTurnRequest.created_at, ChiefTurnRequest.id)
        )
        return list(result.scalars().all())

    async def list_recent_messages(
        self,
        thread_id: str,
        *,
        limit: int = MAX_RECENT_MESSAGES,
        character_limit: int = MAX_RECENT_CHARACTERS,
    ) -> list[ChiefMessageRecord]:
        if not 1 <= limit <= MAX_RECENT_MESSAGES:
            raise ValueError("recent message limit must be 1..8")
        if not 1 <= character_limit <= MAX_RECENT_CHARACTERS:
            raise ValueError("recent message character limit must be 1..12000")
        await self._load_thread(thread_id)
        result = await self._db.execute(
            select(ChiefMessage)
            .where(ChiefMessage.thread_id == thread_id)
            .order_by(ChiefMessage.created_at.desc(), ChiefMessage.id.desc())
            .limit(limit)
        )
        newest_first = list(result.scalars().all())
        selected: list[ChiefMessage] = []
        used = 0
        for message in newest_first:
            if used + len(message.text) > character_limit:
                continue
            selected.append(message)
            used += len(message.text)
        return [self._message_record(row) for row in reversed(selected)]

    @staticmethod
    def _message_record(message: ChiefMessage) -> ChiefMessageRecord:
        return ChiefMessageRecord(
            id=message.id,
            thread_id=message.thread_id,
            role=message.role,
            kind=message.kind,
            text=message.text,
            payload=_decode_object(message.payload_json),
            in_reply_to_message_id=message.in_reply_to_message_id,
            created_at=message.created_at,
        )
