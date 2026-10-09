import importlib
import inspect
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi.routing import APIRoute
from sqlalchemy import event, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.database import Base
from app.models import Project, Run, Task
from app import tmux_service as real_tmux_service
from app.tmux_service import TmuxServiceError, TmuxSessionInfo


def _load_control_center_service():
    """Import inside tests so a missing RED production module does not stop collection."""
    return importlib.import_module("app.control_center_service")


@asynccontextmanager
async def _temporary_db(tmp_path: Path, *, query_log: list[str] | None = None):
    engine = create_async_engine(
        f"sqlite+aiosqlite:///{tmp_path / 'control-center.db'}"
    )
    sessions = async_sessionmaker(
        engine,
        class_=AsyncSession,
        expire_on_commit=False,
    )
    if query_log is not None:
        @event.listens_for(engine.sync_engine, "before_cursor_execute")
        def record_query(_connection, _cursor, statement, _parameters, _context, _many):
            query_log.append(statement)
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


def _tmux_session(
    name: str,
    *,
    path: Path,
    created_at: datetime,
    attached: bool = False,
    codex: bool = False,
    recent: bool = False,
    last_activity_at: datetime | None = None,
) -> TmuxSessionInfo:
    return TmuxSessionInfo(
        name=name,
        path=str(path),
        created_at=created_at,
        windows=2,
        attached=attached,
        current_command="codex" if codex else "bash",
        is_codex_running=codex,
        has_recent_activity=recent,
        last_activity_at=last_activity_at,
    )


async def _durable_rows(db: AsyncSession):
    async def rows_for(model):
        rows = (await db.execute(select(model).order_by(model.id))).scalars().all()
        columns = tuple(model.__table__.columns)
        return tuple(
            tuple(getattr(row, column.name) for column in columns)
            for row in rows
        )

    return (
        await rows_for(Project),
        await rows_for(Task),
        await rows_for(Run),
    )


@pytest.mark.asyncio
async def test_snapshot_keeps_every_project_and_task_in_stable_source_order(
    tmp_path,
    monkeypatch,
):
    service = _load_control_center_service()
    workspace_root = tmp_path / "workspaces"
    ready_path = workspace_root / "ready"
    taskless_path = workspace_root / "taskless"
    file_path = workspace_root / "not-a-directory"
    outside_path = tmp_path / "outside"
    ready_path.mkdir(parents=True)
    taskless_path.mkdir()
    file_path.write_text("not a directory")
    outside_path.mkdir()
    monkeypatch.setenv("DOLPHIN_WORKSPACE_ROOTS", str(workspace_root))

    inventory_calls = 0

    async def list_all_sessions():
        nonlocal inventory_calls
        inventory_calls += 1
        return []

    async def no_pane_probe_expected(_session_name, *, strict=False):
        raise AssertionError("No pane path probe is needed for an empty inventory")

    monkeypatch.setattr(service.tmux_service, "list_all_sessions", list_all_sessions)
    monkeypatch.setattr(
        service.tmux_service,
        "pane_current_paths",
        no_pane_probe_expected,
    )

    at = datetime(2026, 7, 22, 1, 0, tzinfo=timezone.utc)
    projects = [
        _project(
            "project-outside",
            name="Outside",
            path=str(outside_path),
            position=3,
            created_at=at,
        ),
        _project(
            "project-file",
            name="File",
            path=str(file_path),
            position=2,
            created_at=at,
        ),
        _project(
            "project-taskless",
            name="Taskless",
            path=str(taskless_path),
            position=1,
            created_at=at + timedelta(minutes=1),
        ),
        _project(
            "project-ready",
            name="Ready",
            path=str(ready_path),
            position=1,
            created_at=at,
            is_inbox=True,
        ),
        _project(
            "project-unlinked",
            name="Unlinked",
            path=None,
            position=0,
            created_at=at,
        ),
        _project(
            "project-missing",
            name="Missing",
            path=str(workspace_root / "missing"),
            position=0,
            created_at=at,
        ),
    ]
    tasks = [
        _task(
            "task-z",
            project_id="project-ready",
            title="Later source task",
            position=2,
            created_at=at,
            priority=1,
        ),
        _task(
            "task-b",
            project_id="project-ready",
            title="Same-position B",
            position=0,
            created_at=at,
            priority=4,
        ),
        _task(
            "task-complete",
            project_id="project-ready",
            title="Already complete",
            position=-1,
            created_at=at,
            priority=1,
            is_done=True,
        ),
        _task(
            "task-a",
            project_id="project-ready",
            title="Same-position A",
            position=0,
            created_at=at,
            priority=1,
        ),
    ]
    tasks[-1].origin = "dolphin"
    tasks[-1].execution_prompt = "Execute the exact Dolphin-approved task."

    async with _temporary_db(tmp_path) as db:
        db.add_all([*projects, *tasks])
        await db.commit()

        snapshot = await service.build_control_center(db)

    project_ids = [project.id for project in snapshot.projects]
    assert project_ids == [
        "project-missing",
        "project-unlinked",
        "project-ready",
        "project-taskless",
        "project-file",
        "project-outside",
    ]
    assert len(project_ids) == len(set(project_ids)) == 6
    assert snapshot.project_count == 6
    assert snapshot.open_task_count == 3
    assert snapshot.needs_setup_count == 4
    assert snapshot.unique_session_count == 0
    assert snapshot.codex_session_count == 0
    assert snapshot.collected_at.tzinfo is not None
    assert inventory_calls == 1

    projects_by_id = {project.id: project for project in snapshot.projects}
    assert [task.id for task in projects_by_id["project-ready"].tasks] == [
        "task-a",
        "task-b",
        "task-z",
        "task-complete",
    ]
    assert projects_by_id["project-ready"].tasks[-1].workflow_state == "done"
    planned = projects_by_id["project-ready"].tasks[0]
    assert planned.origin == "dolphin"
    assert planned.execution_prompt == "Execute the exact Dolphin-approved task."
    assert [
        task.is_done for task in projects_by_id["project-ready"].tasks
    ] == [False, False, False, True]
    assert projects_by_id["project-taskless"].tasks == []
    assert projects_by_id["project-unlinked"].workspace.state == "unlinked"
    assert projects_by_id["project-missing"].workspace.state == "missing"
    assert projects_by_id["project-file"].workspace.state == "not_directory"
    assert projects_by_id["project-outside"].workspace.state == "outside_root"


@pytest.mark.asyncio
async def test_snapshot_discovers_tmux_once_and_preserves_nested_session_facts(
    tmp_path,
    monkeypatch,
):
    service = _load_control_center_service()
    workspace_root = tmp_path / "workspaces"
    parent_path = workspace_root / "parent"
    nested_path = parent_path / "nested"
    nested_src_path = nested_path / "src"
    sibling_path = parent_path / "sibling"
    nested_src_path.mkdir(parents=True)
    sibling_path.mkdir()
    monkeypatch.setenv("DOLPHIN_WORKSPACE_ROOTS", str(workspace_root))

    at = datetime(2026, 7, 22, 2, 0, tzinfo=timezone.utc)
    shared_activity = datetime(2026, 7, 22, 1, 30, tzinfo=timezone.utc)
    recent_activity = datetime(2026, 7, 22, 2, 15, tzinfo=timezone.utc)
    shared = _tmux_session(
        "z-shared",
        path=parent_path,
        created_at=at + timedelta(minutes=1),
        attached=True,
        codex=True,
        last_activity_at=shared_activity,
    )
    recent = _tmux_session(
        "a-recent",
        path=sibling_path,
        created_at=at,
        recent=True,
        last_activity_at=recent_activity,
    )
    inventory_calls = 0
    pane_calls: list[str] = []

    async def list_all_sessions():
        nonlocal inventory_calls
        inventory_calls += 1
        return [shared, recent]

    async def pane_current_paths(session_name, *, strict=False):
        assert strict is True
        pane_calls.append(session_name)
        if session_name == shared.name:
            return [nested_src_path]
        return []

    monkeypatch.setattr(service.tmux_service, "list_all_sessions", list_all_sessions)
    monkeypatch.setattr(
        service.tmux_service,
        "pane_current_paths",
        pane_current_paths,
    )

    async with _temporary_db(tmp_path) as db:
        db.add_all(
            [
                _project(
                    "project-parent",
                    name="Parent",
                    path=str(parent_path),
                    position=0,
                    created_at=at,
                ),
                _project(
                    "project-nested",
                    name="Nested",
                    path=str(nested_path),
                    position=1,
                    created_at=at,
                ),
            ]
        )
        await db.commit()

        snapshot = await service.build_control_center(db)

    assert inventory_calls == 1
    assert pane_calls == ["z-shared", "a-recent"]
    assert snapshot.tmux.state == "available"
    assert snapshot.unique_session_count == 2
    assert snapshot.codex_session_count == 1

    projects_by_id = {project.id: project for project in snapshot.projects}
    assert [s.name for s in projects_by_id["project-parent"].sessions] == [
        "z-shared",
        "a-recent",
    ]
    assert [s.name for s in projects_by_id["project-nested"].sessions] == [
        "z-shared"
    ]

    observed = projects_by_id["project-parent"].sessions
    assert observed[0].attached is True
    assert observed[0].is_codex_running is True
    assert observed[0].has_recent_activity is False
    assert observed[0].current_command == "codex"
    assert observed[0].last_activity_at == shared_activity
    assert observed[1].attached is False
    assert observed[1].is_codex_running is False
    assert observed[1].has_recent_activity is True
    assert observed[1].current_command == "bash"
    assert observed[1].last_activity_at == recent_activity


@pytest.mark.asyncio
async def test_snapshot_preserves_none_last_activity_at_for_sessions_without_activity(
    tmp_path,
    monkeypatch,
):
    """Verify that sessions with last_activity_at=None preserve None through snapshot."""
    service = _load_control_center_service()
    workspace_root = tmp_path / "workspaces"
    ready_path = workspace_root / "ready"
    ready_path.mkdir(parents=True)
    monkeypatch.setenv("DOLPHIN_WORKSPACE_ROOTS", str(workspace_root))

    at = datetime(2026, 7, 22, 3, 0, tzinfo=timezone.utc)
    # Session with no activity time (last_activity_at=None)
    idle_session = _tmux_session(
        "dolphin-no-activity",
        path=ready_path,
        created_at=at,
        attached=False,
        codex=False,
        recent=False,
        last_activity_at=None,
    )
    inventory_calls = 0
    pane_calls: list[str] = []

    async def list_all_sessions():
        nonlocal inventory_calls
        inventory_calls += 1
        return [idle_session]

    async def pane_current_paths(session_name, *, strict=False):
        assert strict is True
        pane_calls.append(session_name)
        return [ready_path]

    monkeypatch.setattr(service.tmux_service, "list_all_sessions", list_all_sessions)
    monkeypatch.setattr(
        service.tmux_service,
        "pane_current_paths",
        pane_current_paths,
    )

    async with _temporary_db(tmp_path) as db:
        db.add_all(
            [
                _project(
                    "project-ready",
                    name="Ready",
                    path=str(ready_path),
                    position=0,
                    created_at=at,
                ),
            ]
        )
        await db.commit()

        snapshot = await service.build_control_center(db)

    assert inventory_calls == 1
    projects_by_id = {project.id: project for project in snapshot.projects}
    observed = projects_by_id["project-ready"].sessions
    assert len(observed) == 1
    assert observed[0].name == "dolphin-no-activity"
    assert observed[0].last_activity_at is None


@pytest.mark.asyncio
async def test_global_tmux_failure_preserves_durable_facts_and_marks_unavailable(
    tmp_path,
    monkeypatch,
):
    service = _load_control_center_service()
    workspace_root = tmp_path / "workspaces"
    ready_path = workspace_root / "ready"
    ready_path.mkdir(parents=True)
    monkeypatch.setenv("DOLPHIN_WORKSPACE_ROOTS", str(workspace_root))

    inventory_calls = 0

    async def list_all_sessions():
        nonlocal inventory_calls
        inventory_calls += 1
        raise TmuxServiceError("permission denied while listing private socket")

    async def no_pane_probe_expected(_session_name, *, strict=False):
        raise AssertionError("Pane probes must not run after inventory failure")

    monkeypatch.setattr(service.tmux_service, "list_all_sessions", list_all_sessions)
    monkeypatch.setattr(
        service.tmux_service,
        "pane_current_paths",
        no_pane_probe_expected,
    )

    at = datetime(2026, 7, 22, 3, 0, tzinfo=timezone.utc)
    async with _temporary_db(tmp_path) as db:
        db.add_all(
            [
                _project(
                    "project-ready",
                    name="Ready",
                    path=str(ready_path),
                    position=0,
                    created_at=at,
                ),
                _project(
                    "project-unlinked",
                    name="Unlinked",
                    path=None,
                    position=1,
                    created_at=at,
                ),
                _task(
                    "task-open",
                    project_id="project-ready",
                    title="Durable task",
                    position=0,
                    created_at=at,
                ),
            ]
        )
        await db.commit()

        snapshot = await service.build_control_center(db)

    assert inventory_calls == 1
    assert snapshot.status == "degraded"
    assert snapshot.tmux.state == "unavailable"
    assert snapshot.tmux.message
    assert [project.id for project in snapshot.projects] == [
        "project-ready",
        "project-unlinked",
    ]
    assert [task.id for task in snapshot.projects[0].tasks] == ["task-open"]
    assert snapshot.projects[0].sessions == []
    assert snapshot.project_count == 2
    assert snapshot.open_task_count == 1


@pytest.mark.asyncio
async def test_failed_pane_path_probe_degrades_observation_without_hiding_session(
    tmp_path,
    monkeypatch,
):
    service = _load_control_center_service()
    workspace_root = tmp_path / "workspaces"
    ready_path = workspace_root / "ready"
    ready_path.mkdir(parents=True)
    monkeypatch.setenv("DOLPHIN_WORKSPACE_ROOTS", str(workspace_root))

    at = datetime(2026, 7, 22, 4, 0, tzinfo=timezone.utc)
    observed_session = _tmux_session(
        "dolphin-degraded",
        path=ready_path,
        created_at=at,
        attached=True,
        recent=True,
    )

    async def list_all_sessions():
        return [observed_session]

    async def pane_current_paths(_session_name, *, strict=False):
        assert strict is True
        raise TmuxServiceError("private pane path probe detail")

    monkeypatch.setattr(service.tmux_service, "list_all_sessions", list_all_sessions)
    monkeypatch.setattr(
        service.tmux_service,
        "pane_current_paths",
        pane_current_paths,
    )

    async with _temporary_db(tmp_path) as db:
        db.add_all(
            [
                _project(
                    "project-ready",
                    name="Ready",
                    path=str(ready_path),
                    position=0,
                    created_at=at,
                ),
                _task(
                    "task-open",
                    project_id="project-ready",
                    title="Still visible",
                    position=0,
                    created_at=at,
                ),
            ]
        )
        await db.commit()

        snapshot = await service.build_control_center(db)

    assert snapshot.status == "degraded"
    assert snapshot.tmux.state == "degraded"
    assert snapshot.tmux.message
    assert [task.id for task in snapshot.projects[0].tasks] == ["task-open"]
    assert [session.name for session in snapshot.projects[0].sessions] == [
        "dolphin-degraded"
    ]
    assert snapshot.projects[0].sessions[0].observation_state == "degraded"
    assert snapshot.projects[0].sessions[0].observation_message
    assert snapshot.unique_session_count == 1


@pytest.mark.asyncio
async def test_database_query_count_is_bounded_independently_of_project_count(
    tmp_path,
    monkeypatch,
):
    service = _load_control_center_service()
    workspace_root = tmp_path / "workspaces"
    workspace_root.mkdir()
    monkeypatch.setenv("DOLPHIN_WORKSPACE_ROOTS", str(workspace_root))

    async def list_all_sessions():
        return []

    monkeypatch.setattr(service.tmux_service, "list_all_sessions", list_all_sessions)
    query_log: list[str] = []
    at = datetime(2026, 7, 22, 4, 30, tzinfo=timezone.utc)

    async with _temporary_db(tmp_path, query_log=query_log) as db:
        first_path = workspace_root / "first"
        first_path.mkdir()
        db.add(
            _project(
                "project-first",
                name="First",
                path=str(first_path),
                position=0,
                created_at=at,
            )
        )
        await db.commit()

        query_log.clear()
        await service.build_control_center(db)
        one_project_queries = [
            statement for statement in query_log if statement.lstrip().upper().startswith("SELECT")
        ]

        for index in range(12):
            project_path = workspace_root / f"project-{index}"
            project_path.mkdir()
            project_id = f"project-{index:02d}"
            db.add_all(
                [
                    _project(
                        project_id,
                        name=f"Project {index}",
                        path=str(project_path),
                        position=index + 1,
                        created_at=at + timedelta(minutes=index + 1),
                    ),
                    _task(
                        f"task-{index:02d}",
                        project_id=project_id,
                        title=f"Task {index}",
                        position=0,
                        created_at=at,
                    ),
                ]
            )
        await db.commit()

        query_log.clear()
        snapshot = await service.build_control_center(db)
        many_project_queries = [
            statement for statement in query_log if statement.lstrip().upper().startswith("SELECT")
        ]

    assert snapshot.project_count == 13
    # The contract this test protects is flatness with respect to project
    # count, not the literal numbers below: build_control_center's live path
    # now also calls run_service.reconcile_runs, which issues exactly one
    # constant `SELECT ... FROM runs` (list_runs) regardless of how many
    # projects exist or how many runs it finds — so the budget moved from
    # 3 to 4, but it is still one fixed number from 1 project to 13. Kept as
    # an equality check on the many-project side: that equality is what
    # proves there is no N+1.
    # Stage 4 adds a fifth: run_service.latest_runs_by_task, one window-
    # function SELECT returning one row per task. It is deliberately not
    # merged with reconcile_runs' query -- reconciliation needs every open
    # run, the badge needs exactly one per task including terminal ones, and
    # the single query serving both is an unbounded `SELECT * FROM runs`
    # (spec §4.6). Both are flat with respect to project count, which is the
    # contract this test actually protects.
    assert len(one_project_queries) <= 5
    assert len(many_project_queries) == 5


@pytest.mark.asyncio
async def test_snapshot_promotes_a_dispatched_run_when_its_process_is_alive(
    tmp_path,
    monkeypatch,
):
    """IMPORTANT 5, wired at the reconcile call site (spec §4: `-> running`
    fires when the dispatched agent's process is observed alive). This is
    the integration proof that the wiring actually happened at
    `build_control_center`'s tmux inventory read, not just that the
    `run_service.reconcile_runs` primitive underneath it can do it.
    """
    service = _load_control_center_service()
    workspace_root = tmp_path / "workspaces"
    workspace_root.mkdir()
    monkeypatch.setenv("DOLPHIN_WORKSPACE_ROOTS", str(workspace_root))

    session = TmuxSessionInfo(
        name="dolphin-task-session",
        path=str(workspace_root),
        created_at=datetime.now(timezone.utc),
        windows=1,
        attached=False,
        current_command="claude",
        is_codex_running=False,
        is_claude_code_running=True,
        pane_paths=(),
    )

    async def list_all_sessions():
        return [session]

    monkeypatch.setattr(service.tmux_service, "list_all_sessions", list_all_sessions)

    call_order: list[str] = []
    original_reconcile_runs = service.run_service.reconcile_runs
    original_latest_runs_by_task = service.run_service.latest_runs_by_task

    async def reconcile_runs(*args, **kwargs):
        call_order.append("reconcile:start")
        changed = await original_reconcile_runs(*args, **kwargs)
        call_order.append("reconcile:end")
        return changed

    async def latest_runs_by_task(*args, **kwargs):
        call_order.append("latest")
        return await original_latest_runs_by_task(*args, **kwargs)

    monkeypatch.setattr(service.run_service, "reconcile_runs", reconcile_runs)
    monkeypatch.setattr(
        service.run_service,
        "latest_runs_by_task",
        latest_runs_by_task,
    )

    async with _temporary_db(tmp_path) as db:
        db.add_all(
            [
                _project(
                    "p1",
                    name="Observed project",
                    path=str(workspace_root),
                    position=0,
                    created_at=session.created_at,
                ),
                _task(
                    "t1",
                    project_id="p1",
                    title="Observed task",
                    position=0,
                    created_at=session.created_at,
                ),
            ]
        )
        run = Run(
            id="run-alive-1",
            task_id="t1",
            project_id="p1",
            session_name="dolphin-task-session",
            agent="claude",
            workspace_path=str(workspace_root),
            state="dispatched",
        )
        db.add(run)
        await db.commit()

        snapshot = await service.build_control_center(db)

        refreshed = await db.get(Run, "run-alive-1")
        assert refreshed.state == "running"
        assert refreshed.started_at is not None

    assert call_order == ["reconcile:start", "reconcile:end", "latest"]
    assert snapshot.projects[0].tasks[0].latest_run is not None
    assert snapshot.projects[0].tasks[0].latest_run.state == "running"


@pytest.mark.parametrize("failure_type", [OSError, RuntimeError, ValueError])
@pytest.mark.asyncio
async def test_workspace_status_failure_is_isolated_to_its_project(
    tmp_path,
    monkeypatch,
    failure_type,
):
    service = _load_control_center_service()
    workspace_root = tmp_path / "workspaces"
    ready_path = workspace_root / "ready"
    failing_path = workspace_root / "unreadable"
    ready_path.mkdir(parents=True)
    failing_path.mkdir()
    monkeypatch.setenv("DOLPHIN_WORKSPACE_ROOTS", str(workspace_root))

    original_workspace_path_status = service.tmux_service.workspace_path_status

    def workspace_path_status(raw_path):
        if raw_path == str(failing_path):
            raise failure_type("private filesystem detail")
        return original_workspace_path_status(raw_path)

    async def list_all_sessions():
        return []

    monkeypatch.setattr(
        service.tmux_service,
        "workspace_path_status",
        workspace_path_status,
    )
    monkeypatch.setattr(service.tmux_service, "list_all_sessions", list_all_sessions)

    at = datetime(2026, 7, 22, 4, 45, tzinfo=timezone.utc)
    async with _temporary_db(tmp_path) as db:
        db.add_all(
            [
                _project(
                    "project-ready",
                    name="Ready",
                    path=str(ready_path),
                    position=0,
                    created_at=at,
                ),
                _project(
                    "project-failing",
                    name="Failing",
                    path=str(failing_path),
                    position=1,
                    created_at=at,
                ),
                _task(
                    "task-ready",
                    project_id="project-ready",
                    title="Healthy task",
                    position=0,
                    created_at=at,
                ),
                _task(
                    "task-failing",
                    project_id="project-failing",
                    title="Still durable",
                    position=0,
                    created_at=at,
                ),
            ]
        )
        await db.commit()
        snapshot = await service.build_control_center(db)

    projects = {project.id: project for project in snapshot.projects}
    assert snapshot.status == "degraded"
    assert snapshot.tmux.state == "available"
    assert projects["project-ready"].workspace.state == "ready"
    assert projects["project-failing"].workspace.state == "unavailable"
    assert projects["project-failing"].workspace.message
    assert [task.id for task in projects["project-ready"].tasks] == ["task-ready"]
    assert [task.id for task in projects["project-failing"].tasks] == [
        "task-failing"
    ]


@pytest.mark.asyncio
async def test_strict_pane_path_probe_surfaces_tmux_failure(monkeypatch):
    async def failed_tmux(*_args, **_kwargs):
        return 1, "", "pane disappeared"

    monkeypatch.setattr(real_tmux_service, "_run_tmux", failed_tmux)

    with pytest.raises(TmuxServiceError, match="pane"):
        await real_tmux_service.pane_current_paths(
            "dolphin-vanished",
            strict=True,
        )


@pytest.mark.asyncio
async def test_session_metadata_probe_failure_is_explicitly_degraded(monkeypatch):
    separator = real_tmux_service.FIELD_SEPARATOR
    inventory_line = separator.join(
        [
            "dolphin-probe-failure",
            "/tmp/project",
            "1784682000",
            "1",
            "0",
            "1784682000",
        ]
    )

    async def list_inventory(*_args, **_kwargs):
        return 0, f"{inventory_line}\n", ""

    async def failed_current_command(_session_name, *, strict=False):
        assert strict is True
        raise TmuxServiceError("private current-command failure")

    async def failed_codex_detection(_session_name, _pattern, *, strict=False):
        assert strict is True
        raise TmuxServiceError("private process-probe failure")

    monkeypatch.setattr(real_tmux_service, "_run_tmux", list_inventory)
    monkeypatch.setattr(
        real_tmux_service,
        "pane_current_command",
        failed_current_command,
    )
    monkeypatch.setattr(
        real_tmux_service,
        "pane_contains_process",
        failed_codex_detection,
    )

    [observed] = await real_tmux_service.list_all_sessions()

    assert observed.current_command is None
    assert observed.is_codex_running is False
    assert observed.observation_degraded is True


@pytest.mark.asyncio
async def test_metadata_probe_degradation_reaches_snapshot_source(
    tmp_path,
    monkeypatch,
):
    service = _load_control_center_service()
    workspace_root = tmp_path / "workspaces"
    ready_path = workspace_root / "ready"
    ready_path.mkdir(parents=True)
    monkeypatch.setenv("DOLPHIN_WORKSPACE_ROOTS", str(workspace_root))
    at = datetime(2026, 7, 22, 4, 55, tzinfo=timezone.utc)
    observed_session = TmuxSessionInfo(
        name="dolphin-uncertain-codex",
        path=str(ready_path),
        created_at=at,
        windows=1,
        attached=False,
        current_command=None,
        is_codex_running=False,
        has_recent_activity=False,
        observation_degraded=True,
    )

    async def list_all_sessions():
        return [observed_session]

    async def pane_current_paths(_session_name, *, strict=False):
        assert strict is True
        return []

    monkeypatch.setattr(service.tmux_service, "list_all_sessions", list_all_sessions)
    monkeypatch.setattr(
        service.tmux_service,
        "pane_current_paths",
        pane_current_paths,
    )

    async with _temporary_db(tmp_path) as db:
        db.add(
            _project(
                "project-ready",
                name="Ready",
                path=str(ready_path),
                position=0,
                created_at=at,
            )
        )
        await db.commit()
        snapshot = await service.build_control_center(db)

    assert snapshot.status == "degraded"
    assert snapshot.tmux.state == "degraded"
    assert snapshot.codex_session_count == 0
    assert snapshot.projects[0].sessions[0].observation_state == "degraded"
    assert snapshot.projects[0].sessions[0].observation_message


@pytest.mark.asyncio
async def test_task_first_snapshot_defers_tmux_without_losing_durable_work(
    tmp_path,
    monkeypatch,
):
    service = _load_control_center_service()
    workspace_root = tmp_path / "workspaces"
    ready_path = workspace_root / "ready"
    ready_path.mkdir(parents=True)
    missing_path = workspace_root / "missing"
    monkeypatch.setenv("DOLPHIN_WORKSPACE_ROOTS", str(workspace_root))

    async def forbidden_list_all_sessions():
        raise AssertionError("A task-first snapshot must not inspect tmux")

    monkeypatch.setattr(
        service.tmux_service,
        "list_all_sessions",
        forbidden_list_all_sessions,
    )

    at = datetime(2026, 7, 22, 5, 0, tzinfo=timezone.utc)
    async with _temporary_db(tmp_path) as db:
        db.add_all(
            [
                _project(
                    "project-ready",
                    name="Ready",
                    path=str(ready_path),
                    position=0,
                    created_at=at,
                ),
                _project(
                    "project-missing",
                    name="Missing",
                    path=str(missing_path),
                    position=1,
                    created_at=at,
                ),
                _project(
                    "project-unlinked",
                    name="Unlinked",
                    path=None,
                    position=2,
                    created_at=at,
                ),
                _task(
                    "task-ready",
                    project_id="project-ready",
                    title="Ready durable task",
                    position=0,
                    created_at=at,
                ),
                _task(
                    "task-missing",
                    project_id="project-missing",
                    title="Missing workspace task",
                    position=0,
                    created_at=at,
                ),
                _task(
                    "task-complete",
                    project_id="project-ready",
                    title="Already complete",
                    position=1,
                    created_at=at,
                    is_done=True,
                ),
            ]
        )
        await db.commit()

        snapshot = await service.build_control_center(
            db,
            include_sessions=False,
        )

    assert [project.id for project in snapshot.projects] == [
        "project-ready",
        "project-missing",
        "project-unlinked",
    ]
    assert snapshot.project_count == 3
    assert snapshot.open_task_count == 2
    assert snapshot.needs_setup_count == 2
    assert snapshot.unique_session_count == 0
    assert snapshot.codex_session_count == 0
    assert snapshot.tmux.state == "unavailable"
    assert snapshot.tmux.message
    assert "deferred" in snapshot.tmux.message.lower()

    projects = {project.id: project for project in snapshot.projects}
    assert projects["project-ready"].workspace.state == "ready"
    assert projects["project-missing"].workspace.state == "missing"
    assert projects["project-unlinked"].workspace.state == "unlinked"
    assert [task.id for task in projects["project-ready"].tasks] == [
        "task-ready",
        "task-complete",
    ]
    assert projects["project-ready"].tasks[-1].workflow_state == "done"
    assert [task.id for task in projects["project-missing"].tasks] == [
        "task-missing"
    ]
    assert projects["project-unlinked"].tasks == []
    assert all(project.sessions == [] for project in snapshot.projects)
    assert all(project.session_count == 0 for project in snapshot.projects)
    assert all(project.codex_session_count == 0 for project in snapshot.projects)


@pytest.mark.asyncio
async def test_snapshot_is_read_only_and_never_invokes_tmux_mutations(
    tmp_path,
    monkeypatch,
):
    service = _load_control_center_service()
    workspace_root = tmp_path / "workspaces"
    ready_path = workspace_root / "ready"
    ready_path.mkdir(parents=True)
    monkeypatch.setenv("DOLPHIN_WORKSPACE_ROOTS", str(workspace_root))

    async def list_all_sessions():
        return []

    async def forbidden_mutation(*_args, **_kwargs):
        raise AssertionError("A control-center snapshot must not mutate tmux")

    monkeypatch.setattr(service.tmux_service, "list_all_sessions", list_all_sessions)
    for mutation_name in (
        "create_session",
        "kill_session",
        "send_input",
        "send_key",
        "start_codex",
    ):
        monkeypatch.setattr(
            service.tmux_service,
            mutation_name,
            forbidden_mutation,
        )

    at = datetime(2026, 7, 22, 5, 0, tzinfo=timezone.utc)
    async with _temporary_db(tmp_path) as db:
        db.add_all(
            [
                _project(
                    "project-ready",
                    name="Ready",
                    path=str(ready_path),
                    position=0,
                    created_at=at,
                ),
                _task(
                    "task-open",
                    project_id="project-ready",
                    title="Must remain unchanged",
                    position=0,
                    created_at=at,
                ),
            ]
        )
        await db.commit()
        before = await _durable_rows(db)

        await service.build_control_center(db)

        after = await _durable_rows(db)

    assert after == before


@pytest.mark.asyncio
async def test_observation_only_snapshot_preserves_sessions_without_reconciliation(
    tmp_path,
    monkeypatch,
):
    service = _load_control_center_service()
    workspace_root = tmp_path / "workspaces"
    ready_path = workspace_root / "ready"
    ready_path.mkdir(parents=True)
    monkeypatch.setenv("DOLPHIN_WORKSPACE_ROOTS", str(workspace_root))

    at = datetime(2026, 8, 10, 9, 0, tzinfo=timezone.utc)
    observed_session = TmuxSessionInfo(
        name="dolphin-observation",
        path=str(ready_path),
        created_at=at,
        windows=2,
        attached=True,
        current_command="codex",
        is_codex_running=True,
        has_recent_activity=True,
        pane_paths=(str(ready_path / "src"),),
    )
    inventory_calls = 0

    async def list_all_sessions():
        nonlocal inventory_calls
        inventory_calls += 1
        return [observed_session]

    async def forbidden_reconciliation(*_args, **_kwargs):
        raise AssertionError("Observation-only snapshots must not reconcile runs")

    async def forbidden_tmux_mutation(*_args, **_kwargs):
        raise AssertionError("Observation-only snapshots must not mutate tmux")

    monkeypatch.setattr(service.tmux_service, "list_all_sessions", list_all_sessions)
    monkeypatch.setattr(
        service.run_service,
        "reconcile_runs",
        forbidden_reconciliation,
    )
    for mutation_name in (
        "create_session",
        "kill_session",
        "send_input",
        "send_key",
        "start_codex",
    ):
        monkeypatch.setattr(
            service.tmux_service,
            mutation_name,
            forbidden_tmux_mutation,
        )

    async with _temporary_db(tmp_path) as db:
        db.add_all(
            [
                _project(
                    "project-chief",
                    name="Chief project",
                    path=str(ready_path),
                    position=0,
                    created_at=at,
                ),
                _task(
                    "task-chief",
                    project_id="project-chief",
                    title="Observe this task",
                    position=0,
                    created_at=at,
                ),
                Run(
                    id="run-chief",
                    task_id="task-chief",
                    project_id="project-chief",
                    session_name=observed_session.name,
                    agent="codex",
                    workspace_path=str(ready_path),
                    state="dispatched",
                    dispatched_at=at,
                ),
            ]
        )
        await db.commit()
        before = await _durable_rows(db)

        snapshot = await service.build_control_center(
            db,
            include_sessions=True,
            reconcile_run_state=False,
        )

        after = await _durable_rows(db)

    assert after == before
    assert inventory_calls == 1
    assert snapshot.tmux.state == "available"
    assert snapshot.unique_session_count == 1
    assert snapshot.codex_session_count == 1
    [project] = snapshot.projects
    [session] = project.sessions
    assert session.name == observed_session.name
    assert session.attached is True
    assert session.windows == 2
    assert session.current_command == "codex"
    assert session.is_codex_running is True
    assert session.has_recent_activity is True
    assert session.observation_state == "available"
    assert project.tasks[0].latest_run is not None
    assert project.tasks[0].latest_run.state == "dispatched"


def test_control_center_route_declares_a_typed_read_response():
    main = importlib.import_module("app.main")
    schemas = importlib.import_module("app.schemas")
    response_model = getattr(schemas, "ControlCenterResponse")
    routes = [
        route
        for route in main.app.routes
        if isinstance(route, APIRoute) and route.path == "/api/control-center"
    ]

    assert len(routes) == 1
    route = routes[0]
    assert route.methods == {"GET"}
    assert route.response_model is response_model
    assert inspect.iscoroutinefunction(route.endpoint)
    assert "db" in inspect.signature(route.endpoint).parameters


@pytest.mark.asyncio
async def test_control_center_deck_route_declares_a_typed_async_read_response(
    monkeypatch,
):
    main = importlib.import_module("app.main")
    schemas = importlib.import_module("app.schemas")
    response_model = getattr(schemas, "ControlCenterResponse")
    routes = [
        route
        for route in main.app.routes
        if isinstance(route, APIRoute) and route.path == "/api/control-center/deck"
    ]

    assert len(routes) == 1
    route = routes[0]
    assert route.methods == {"GET"}
    assert route.response_model is response_model
    assert inspect.iscoroutinefunction(route.endpoint)
    assert "db" in inspect.signature(route.endpoint).parameters

    calls: list[tuple[object, bool]] = []
    sentinel_db = object()
    sentinel_response = object()

    async def build_control_center(db, *, include_sessions=True):
        calls.append((db, include_sessions))
        return sentinel_response

    monkeypatch.setattr(main, "build_control_center", build_control_center)

    result = await route.endpoint(db=sentinel_db)

    assert result is sentinel_response
    assert calls == [(sentinel_db, False)]


def test_session_response_carries_last_activity_at():
    from app.schemas import ControlCenterSessionResponse

    activity = datetime(2026, 8, 13, 4, 0, tzinfo=timezone.utc)
    response = ControlCenterSessionResponse(
        name="dolphin-idle",
        path="/tmp/project",
        created_at=datetime(2026, 8, 1, tzinfo=timezone.utc),
        windows=1,
        attached=False,
        current_command="node",
        is_codex_running=True,
        has_recent_activity=False,
        last_activity_at=activity,
    )

    assert response.last_activity_at == activity


def test_session_response_last_activity_at_defaults_to_none():
    from app.schemas import ControlCenterSessionResponse

    response = ControlCenterSessionResponse(
        name="dolphin-idle",
        path="/tmp/project",
        created_at=datetime(2026, 8, 1, tzinfo=timezone.utc),
        windows=1,
        attached=False,
        current_command=None,
        is_codex_running=False,
        has_recent_activity=False,
    )

    assert response.last_activity_at is None
