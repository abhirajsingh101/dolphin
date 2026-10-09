from datetime import datetime, timezone

import pytest
from sqlalchemy import event, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.orm import selectinload
from starlette.middleware.gzip import GZipMiddleware

from app import main
from app import control_center_service
from app import tmux_service
from app.database import Base
from app.models import Project, Task


def test_api_registers_response_compression():
    # A subclass counts: StreamSafeGZipMiddleware compresses everything except
    # server-sent events, which gzip would otherwise buffer indefinitely.
    assert any(
        isinstance(middleware.cls, type) and issubclass(middleware.cls, GZipMiddleware)
        for middleware in main.app.user_middleware
    )


@pytest.mark.asyncio
async def test_tmux_inventory_batches_pane_and_process_observation(monkeypatch):
    separator = tmux_service.FIELD_SEPARATOR
    created_at = int(datetime(2026, 7, 24, tzinfo=timezone.utc).timestamp())
    session_rows = "\n".join(
        [
            separator.join(
                ["dolphin-alpha", "/work/alpha", str(created_at), "1", "0", str(created_at)]
            ),
            separator.join(
                ["dolphin-beta", "/work/beta", str(created_at), "1", "1", str(created_at)]
            ),
        ]
    )
    pane_rows = "\n".join(
        [
            separator.join(
                ["dolphin-alpha", "/work/alpha", "bash", "101"]
            ),
            separator.join(
                ["dolphin-beta", "/work/beta/subdir", "node", "202"]
            ),
        ]
    )
    tmux_calls: list[tuple[str, ...]] = []
    process_batches: list[tuple[int, ...]] = []

    async def fake_run_tmux(*args, check=True):
        tmux_calls.append(args)
        if args[0] == "list-sessions":
            return 0, f"{session_rows}\n", ""
        if args[:2] == ("list-panes", "-a"):
            return 0, f"{pane_rows}\n", ""
        raise AssertionError(f"unexpected tmux call: {args}")

    def fake_detect(pane_pids):
        process_batches.append(tuple(pane_pids))
        return {202}, {101}

    monkeypatch.setattr(tmux_service, "_run_tmux", fake_run_tmux)
    monkeypatch.setattr(
        tmux_service,
        "_pane_pids_containing_supported_agents",
        fake_detect,
        raising=False,
    )

    sessions = await tmux_service._list_all_sessions_uncached()

    assert [call[0:2] for call in tmux_calls] == [
        ("list-sessions", "-F"),
        ("list-panes", "-a"),
    ]
    assert process_batches == [(101, 202)]
    assert sessions[0].pane_paths == ("/work/alpha",)
    assert sessions[0].current_command == "bash"
    assert sessions[0].is_codex_running is False
    assert sessions[0].is_claude_code_running is True
    assert sessions[1].pane_paths == ("/work/beta/subdir",)
    assert sessions[1].current_command == "node"
    assert sessions[1].is_codex_running is True
    assert sessions[1].is_claude_code_running is False


@pytest.mark.asyncio
async def test_eager_task_serialization_does_not_issue_per_task_queries(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'tasks.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with session_factory() as db:
        project = Project(id="project-fast", name="Fast project", position=0)
        db.add(project)
        db.add_all(
            [
                Task(
                    id=f"task-{index}",
                    project_id=project.id,
                    title=f"Task {index}",
                    position=index,
                )
                for index in range(20)
            ]
        )
        await db.commit()
        result = await db.execute(
            select(Task).options(
                selectinload(Task.labels),
                selectinload(Task.project),
                selectinload(Task.workflow),
            )
        )
        tasks = list(result.scalars().all())

        query_count = 0

        def count_query(*_args):
            nonlocal query_count
            query_count += 1

        event.listen(engine.sync_engine, "before_cursor_execute", count_query)
        try:
            responses = [await main._task_response(task, db) for task in tasks]
        finally:
            event.remove(engine.sync_engine, "before_cursor_execute", count_query)

    await engine.dispose()
    assert len(responses) == 20
    assert query_count == 0


@pytest.mark.asyncio
async def test_durable_deck_cache_is_fast_and_invalidates_on_commit(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'deck.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with session_factory() as db:
        db.add(Project(id="project-cache", name="Cached project", position=0))
        await db.commit()
        first = await control_center_service.build_control_center(
            db,
            include_sessions=False,
        )

        query_count = 0

        def count_query(*_args):
            nonlocal query_count
            query_count += 1

        event.listen(engine.sync_engine, "before_cursor_execute", count_query)
        try:
            second = await control_center_service.build_control_center(
                db,
                include_sessions=False,
            )
            cached_query_count = query_count

            db.add(
                Task(
                    id="task-cache-invalidation",
                    project_id="project-cache",
                    title="Invalidate the durable deck",
                )
            )
            await db.commit()
            query_count = 0
            invalidated = await control_center_service.build_control_center(
                db,
                include_sessions=False,
            )
        finally:
            event.remove(engine.sync_engine, "before_cursor_execute", count_query)

    await engine.dispose()
    assert second.projects == first.projects
    assert cached_query_count == 0
    assert query_count > 0
    assert invalidated.open_task_count == 1


@pytest.mark.asyncio
async def test_project_list_uses_one_aggregate_query(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'projects.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with session_factory() as db:
        projects = [
            Project(id=f"project-{index}", name=f"Project {index}", position=index)
            for index in range(20)
        ]
        db.add_all(projects)
        db.add_all(
            [
                Task(
                    id=f"project-task-{index}",
                    project_id=project.id,
                    title=f"Task {index}",
                    is_done=index % 2 == 0,
                )
                for index, project in enumerate(projects)
            ]
        )
        await db.commit()
        query_count = 0

        def count_query(*_args):
            nonlocal query_count
            query_count += 1

        event.listen(engine.sync_engine, "before_cursor_execute", count_query)
        try:
            responses = await main.list_projects(db)
        finally:
            event.remove(engine.sync_engine, "before_cursor_execute", count_query)

    await engine.dispose()
    assert len(responses) == 20
    assert sum(response.task_count for response in responses) == 20
    assert sum(response.done_count for response in responses) == 10
    assert query_count == 1
