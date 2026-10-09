"""The snapshot's latest_run field, which feeds the Kanban card badge."""

from __future__ import annotations

import importlib
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app import run_service
from app.database import Base
from app.models import Project, Task


def _load_control_center_service():
    """Import inside tests so a missing RED production module does not stop collection."""
    return importlib.import_module("app.control_center_service")


@asynccontextmanager
async def _temporary_db(tmp_path: Path):
    engine = create_async_engine(
        f"sqlite+aiosqlite:///{tmp_path / 'control-center.db'}"
    )
    sessions = async_sessionmaker(
        engine,
        class_=AsyncSession,
        expire_on_commit=False,
    )
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    try:
        async with sessions() as db:
            yield db
    finally:
        await engine.dispose()


def _project(
    project_id: str,
    *,
    name: str,
    path: str | None,
    position: int,
    created_at: datetime,
    is_inbox: bool = False,
) -> Project:
    return Project(
        id=project_id,
        name=name,
        emoji="🐬",
        color="#146c94",
        path=path,
        is_inbox=is_inbox,
        position=position,
        created_at=created_at,
        updated_at=created_at,
    )


def _task(
    task_id: str,
    *,
    project_id: str,
    title: str,
    position: int,
    created_at: datetime,
    priority: int = 4,
    is_done: bool = False,
) -> Task:
    return Task(
        id=task_id,
        project_id=project_id,
        title=title,
        description=f"Description for {title}",
        priority=priority,
        is_done=is_done,
        position=position,
        created_at=created_at,
        updated_at=created_at,
        completed_at=created_at if is_done else None,
    )


@pytest.mark.asyncio
async def test_latest_run_is_exposed_for_a_task(tmp_path, monkeypatch):
    service = _load_control_center_service()
    workspace_root = tmp_path / "workspaces"
    workspace_root.mkdir()
    monkeypatch.setenv("DOLPHIN_WORKSPACE_ROOTS", str(workspace_root))

    async def list_all_sessions():
        return []

    monkeypatch.setattr(service.tmux_service, "list_all_sessions", list_all_sessions)
    at = datetime(2026, 8, 9, 12, 0, tzinfo=timezone.utc)

    async with _temporary_db(tmp_path) as db:
        path = workspace_root / "alpha"
        path.mkdir()
        db.add(_project("proj-1", name="Alpha", path=str(path), position=0, created_at=at))
        db.add(_task("task-1", project_id="proj-1", title="Ship it", position=0, created_at=at))
        await db.commit()

        run = await run_service.create_run(
            db, task_id="task-1", project_id="proj-1",
            session_name="s1", agent="claude", workspace_path=str(path),
        )
        await run_service.transition(db, run, "needs_review")

        snapshot = await service.build_control_center(db)

    task = snapshot.projects[0].tasks[0]
    assert task.latest_run is not None
    assert task.latest_run.state == "needs_review"
    assert task.latest_run.agent == "claude"


@pytest.mark.asyncio
async def test_an_approved_run_still_owns_the_field(tmp_path, monkeypatch):
    """The regression this field exists to prevent: if latest_run went null on
    approval, the card would fall back to research_status and render
    "Researching" again -- restoring the inference Phase B removes."""
    service = _load_control_center_service()
    workspace_root = tmp_path / "workspaces"
    workspace_root.mkdir()
    monkeypatch.setenv("DOLPHIN_WORKSPACE_ROOTS", str(workspace_root))

    async def list_all_sessions():
        return []

    monkeypatch.setattr(service.tmux_service, "list_all_sessions", list_all_sessions)
    at = datetime(2026, 8, 9, 12, 0, tzinfo=timezone.utc)

    async with _temporary_db(tmp_path) as db:
        path = workspace_root / "alpha"
        path.mkdir()
        db.add(_project("proj-1", name="Alpha", path=str(path), position=0, created_at=at))
        db.add(_task("task-1", project_id="proj-1", title="Ship it", position=0, created_at=at))
        await db.commit()

        run = await run_service.create_run(
            db, task_id="task-1", project_id="proj-1",
            session_name="s1", agent="claude", workspace_path=str(path),
        )
        await run_service.transition(db, run, "needs_review")
        await run_service.transition(db, run, "approved")

        snapshot = await service.build_control_center(db)

    assert snapshot.projects[0].tasks[0].latest_run.state == "approved"


@pytest.mark.asyncio
async def test_only_the_newest_run_is_reported(tmp_path, monkeypatch):
    service = _load_control_center_service()
    workspace_root = tmp_path / "workspaces"
    workspace_root.mkdir()
    monkeypatch.setenv("DOLPHIN_WORKSPACE_ROOTS", str(workspace_root))

    async def list_all_sessions():
        return []

    monkeypatch.setattr(service.tmux_service, "list_all_sessions", list_all_sessions)
    at = datetime(2026, 8, 9, 12, 0, tzinfo=timezone.utc)

    async with _temporary_db(tmp_path) as db:
        path = workspace_root / "alpha"
        path.mkdir()
        db.add(_project("proj-1", name="Alpha", path=str(path), position=0, created_at=at))
        db.add(_task("task-1", project_id="proj-1", title="Ship it", position=0, created_at=at))
        await db.commit()

        first = await run_service.create_run(
            db, task_id="task-1", project_id="proj-1",
            session_name="s1", agent="claude", workspace_path=str(path),
        )
        # `_ALLOWED["dispatched"]` has no direct path to "dismissed" (only
        # "awaiting_receipt" and "needs_review" do) -- route through the
        # legal intermediate state to reach the same terminal state the
        # brief's test intends.
        await run_service.transition(db, first, "awaiting_receipt")
        await run_service.transition(db, first, "dismissed")
        second = await run_service.create_run(
            db, task_id="task-1", project_id="proj-1",
            session_name="s1", agent="claude", workspace_path=str(path),
        )
        second.dispatched_at = first.dispatched_at + timedelta(minutes=5)
        await db.commit()

        snapshot = await service.build_control_center(db)

    assert snapshot.projects[0].tasks[0].latest_run.id == second.id


@pytest.mark.asyncio
async def test_a_task_that_never_ran_has_no_latest_run(tmp_path, monkeypatch):
    service = _load_control_center_service()
    workspace_root = tmp_path / "workspaces"
    workspace_root.mkdir()
    monkeypatch.setenv("DOLPHIN_WORKSPACE_ROOTS", str(workspace_root))

    async def list_all_sessions():
        return []

    monkeypatch.setattr(service.tmux_service, "list_all_sessions", list_all_sessions)
    at = datetime(2026, 8, 9, 12, 0, tzinfo=timezone.utc)

    async with _temporary_db(tmp_path) as db:
        path = workspace_root / "alpha"
        path.mkdir()
        db.add(_project("proj-1", name="Alpha", path=str(path), position=0, created_at=at))
        db.add(_task("task-1", project_id="proj-1", title="Ship it", position=0, created_at=at))
        await db.commit()

        snapshot = await service.build_control_center(db)

    assert snapshot.projects[0].tasks[0].latest_run is None
