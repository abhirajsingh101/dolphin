"""Turn-end notifications: collect agent turns that tmux panes recorded.

``scripts/dolphin-automation-hook`` leaves each finished Claude or Codex turn
on its pane as ``@dolphin-turn``. A loop here reads every pane in one tmux call,
stores turns it has not seen as ``notifications`` rows, and pushes them to the
browsers subscribed to the stream. The record waits in tmux, so a turn that ends
while the backend restarts is still collected.

Known limit: a pane that finishes two turns within one scan keeps only the
later record, and a session killed within one scan of finishing is missed.
Spec: docs/superpowers/specs/2026-10-07-turn-end-notifications-design.md
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path

from sqlalchemy import delete, select

from .models import Notification, Project
from .tmux_service import _run_tmux

logger = logging.getLogger(__name__)

OPTION = "@dolphin-turn"
SCAN_SECONDS = 2.0
RETAIN = timedelta(days=7)
KEEP = 500
PROVIDERS = {"claude", "codex"}
MAX_SUMMARY_CHARS = 300


class Broadcaster:
    """Fan new notifications out to every open stream, without blocking."""

    def __init__(self) -> None:
        self._queues: set[asyncio.Queue] = set()

    def subscribe(self) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue(maxsize=100)
        self._queues.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue) -> None:
        self._queues.discard(queue)

    def publish(self, item: dict) -> None:
        for queue in list(self._queues):
            with contextlib.suppress(asyncio.QueueFull):
                queue.put_nowait(item)


def to_item(row: Notification, project_name: str | None) -> dict:
    return {
        "id": row.id,
        "kind": row.kind,
        "turn_id": row.turn_id,
        "provider": row.provider,
        "project_id": row.project_id,
        "project_name": project_name,
        "session_name": row.session_name,
        "pane_id": row.pane_id,
        "summary": row.summary,
        "finished_at": _iso(row.finished_at),
        "created_at": _iso(row.created_at),
        "read": row.read_at is not None,
    }


def _iso(value: datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat()


def _parse_turn(raw: str) -> dict | None:
    try:
        turn = json.loads(raw)
        finished_at = datetime.fromisoformat(turn["finished_at"])
    except (ValueError, TypeError, KeyError):
        return None
    if not isinstance(turn, dict) or turn.get("provider") not in PROVIDERS:
        return None
    turn_id, summary = turn.get("id"), turn.get("summary", "")
    if not isinstance(turn_id, str) or not 0 < len(turn_id) <= 64 or not isinstance(summary, str):
        return None
    if finished_at.tzinfo is None:
        finished_at = finished_at.replace(tzinfo=timezone.utc)
    return {"id": turn_id, "provider": turn["provider"], "finished_at": finished_at,
            "summary": summary[:MAX_SUMMARY_CHARS]}


async def _pane_turns() -> list[tuple[str, str, str, dict]]:
    """(pane_id, session_name, current_path, turn) for every pane with a turn."""
    code, out, _ = await _run_tmux(
        "list-panes", "-a", "-F",
        "#{pane_id}\t#{session_name}\t#{pane_current_path}\t#{" + OPTION + "}",
        check=False,
    )
    if code != 0:
        return []  # No tmux server is the same as no turns.
    found = []
    for line in out.splitlines():
        parts = line.split("\t", 3)
        if len(parts) != 4 or not parts[3]:
            continue
        turn = _parse_turn(parts[3])
        if turn is not None:
            found.append((parts[0], parts[1], parts[2], turn))
    return found


def _project_for(path: str, projects: list[tuple[str, str, Path]]) -> tuple[str, str] | tuple[None, None]:
    """The deepest configured project whose folder contains ``path``."""
    try:
        resolved = Path(path).expanduser().resolve()
    except (OSError, RuntimeError, ValueError):
        return None, None
    best = None
    for project_id, name, root in projects:
        if resolved == root or root in resolved.parents:
            if best is None or len(root.parts) > len(best[2].parts):
                best = (project_id, name, root)
    return (best[0], best[1]) if best else (None, None)


async def _projects(db) -> list[tuple[str, str, Path]]:
    rows = (await db.execute(select(Project.id, Project.name, Project.path).where(Project.path.is_not(None)))).all()
    projects = []
    for project_id, name, path in rows:
        try:
            projects.append((project_id, name, Path(path).expanduser().resolve()))
        except (OSError, RuntimeError, ValueError):
            continue
    return projects


async def scan_once(session_factory, broadcaster: Broadcaster) -> list[dict]:
    """Store and publish every pane turn not yet recorded; return the new items."""
    turns = await _pane_turns()
    if not turns:
        return []
    async with session_factory() as db:
        known = set((await db.scalars(
            select(Notification.turn_id).where(Notification.turn_id.in_([t[3]["id"] for t in turns]))
        )).all())
        projects = await _projects(db)
        created: list[tuple[Notification, str | None]] = []
        for pane_id, session_name, path, turn in turns:
            if turn["id"] in known:
                continue
            known.add(turn["id"])
            project_id, project_name = _project_for(path, projects)
            row = Notification(
                kind="turn_end", turn_id=turn["id"], provider=turn["provider"],
                project_id=project_id, session_name=session_name, pane_id=pane_id,
                summary=turn["summary"], finished_at=turn["finished_at"],
                created_at=datetime.now(timezone.utc),
            )
            db.add(row)
            created.append((row, project_name))
        if not created:
            return []
        await db.commit()
        items = [to_item(row, name) for row, name in created]
    for item in items:
        broadcaster.publish(item)
    return items


async def prune(db, *, now: datetime | None = None, keep: int = KEEP) -> None:
    now = now or datetime.now(timezone.utc)
    await db.execute(delete(Notification).where(Notification.created_at < now - RETAIN))
    newest = select(Notification.id).order_by(Notification.created_at.desc()).limit(keep)
    await db.execute(delete(Notification).where(Notification.id.not_in(newest)))
    await db.commit()


async def event_stream(broadcaster: Broadcaster, *, heartbeat_seconds: float = 20.0):
    """Server-sent events: one ``notification`` event per new item, and a
    comment heartbeat so proxies keep an idle connection open."""
    queue = broadcaster.subscribe()
    try:
        yield ": connected\n\n"
        while True:
            try:
                item = await asyncio.wait_for(queue.get(), timeout=heartbeat_seconds)
            except asyncio.TimeoutError:
                yield ": ping\n\n"
                continue
            yield f"event: notification\ndata: {json.dumps(item)}\n\n"
    finally:
        broadcaster.unsubscribe(queue)


class Collector:
    """The background loop: scan every couple of seconds, prune now and then."""

    def __init__(self, session_factory, broadcaster: Broadcaster) -> None:
        self._session_factory = session_factory
        self._broadcaster = broadcaster
        self._task: asyncio.Task | None = None

    def start(self) -> None:
        self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
        self._task = None

    async def _run(self) -> None:
        scans = 0
        while True:
            try:
                await scan_once(self._session_factory, self._broadcaster)
                if scans % 900 == 0:  # about every half hour
                    async with self._session_factory() as db:
                        await prune(db)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Turn notification scan failed")
            scans += 1
            await asyncio.sleep(SCAN_SECONDS)
