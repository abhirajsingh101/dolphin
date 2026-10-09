from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.database import Base
from app.models import Project, Task, TaskWorkflow
from app.schemas import TaskCreate
from app.tmux_service import TmuxServiceError, TmuxSessionInfo


@asynccontextmanager
async def _temporary_db(tmp_path: Path):
    engine = create_async_engine(
        f"sqlite+aiosqlite:///{tmp_path / 'task-placement.db'}"
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


def _session(name: str, path: Path) -> TmuxSessionInfo:
    return TmuxSessionInfo(
        name=name,
        path=str(path),
        created_at=datetime.now(timezone.utc),
        windows=1,
        attached=False,
        current_command="codex",
        is_codex_running=True,
    )


async def _seed_inbox_task(
    db: AsyncSession,
    root: Path,
    *,
    title: str,
    description: str = "",
) -> Task:
    inbox_path = root / "brain"
    dolphin_path = root / "dolphin-tasks"
    sim_path = root / "robot-sim"
    for path in (inbox_path, dolphin_path, sim_path):
        path.mkdir(parents=True)
    (dolphin_path / "AGENTS.md").write_text(
        "Dolphin Tasks agent kanban inline capture FastAPI React tmux.\n"
    )
    (sim_path / "README.md").write_text(
        "Physics task verification and robot simulation.\n"
    )
    projects = [
        Project(
            id="inbox",
            name="Inbox",
            path=str(inbox_path),
            is_inbox=True,
            position=0,
        ),
        Project(
            id="dolphin",
            name="Dolphin Tasks",
            path=str(dolphin_path),
            position=1,
        ),
        Project(
            id="robot-sim",
            name="Robot Sim",
            path=str(sim_path),
            position=2,
        ),
    ]
    task = Task(
        id="task-placement-abcdef12",
        project_id="inbox",
        title=title,
        description=description,
        priority=4,
        position=0,
    )
    db.add_all([*projects, task])
    await db.commit()
    return task


def _mock_tmux(monkeypatch, service):
    live_sessions: dict[str, TmuxSessionInfo] = {}
    created: list[tuple[Path, str]] = []
    sent: list[tuple[Path, str, str]] = []

    async def require(path: Path, name: str):
        session = live_sessions.get(name)
        if session is None:
            raise TmuxServiceError("missing", 404)
        return session

    async def create(
        path: Path,
        _project_name: str,
        requested_name: str | None = None,
        mode: str = "shell",
    ):
        assert requested_name is not None
        assert mode == "shell"
        created.append((path, requested_name))
        session = _session(requested_name, path)
        live_sessions[requested_name] = session
        return session

    async def send(
        path: Path,
        name: str,
        text: str,
        enter: bool = True,
        *,
        require_codex: bool = False,
    ):
        assert enter is True
        assert require_codex is True
        sent.append((path, name, text))

    async def list_all():
        return list(live_sessions.values())

    async def kill(path: Path, name: str):
        session = await require(path, name)
        assert Path(session.path).resolve() == path.resolve()
        live_sessions.pop(name)

    monkeypatch.setattr(service.tmux_service, "require_workspace_session", require)
    monkeypatch.setattr(service.tmux_service, "create_session", create)
    monkeypatch.setattr(service.tmux_service, "send_input", send)
    monkeypatch.setattr(service.tmux_service, "list_all_sessions", list_all)
    monkeypatch.setattr(service.tmux_service, "kill_session", kill)
    return live_sessions, created, sent


@pytest.mark.asyncio
async def test_task_creation_without_project_defaults_to_inbox(tmp_path):
    from app.main import create_task

    async with _temporary_db(tmp_path) as db:
        inbox = Project(id="inbox", name="Inbox", is_inbox=True, position=0)
        db.add(inbox)
        await db.commit()

        created = await create_task(
            TaskCreate(title="Capture this immediately"),
            db=db,
        )

        assert created.project_id == "inbox"
        assert created.workflow_state == "todo"


@pytest.mark.asyncio
async def test_inbox_launch_chooses_a_confident_existing_project(
    tmp_path,
    monkeypatch,
):
    from app import task_workflow_service as service

    root = tmp_path / "projects"
    monkeypatch.setenv("DOLPHIN_WORKSPACE_ROOTS", str(root))
    _, created, sent = _mock_tmux(monkeypatch, service)

    async with _temporary_db(tmp_path) as db:
        task = await _seed_inbox_task(
            db,
            root,
            title="Polish Dolphin agent kanban inline capture",
        )

        result = await service.launch_task_research(db, task.id)
        await db.refresh(task)
        workflow = await db.get(TaskWorkflow, task.id)

        assert result.placement_kind == "matched_project"
        assert result.project_id == "dolphin"
        assert result.project_name == "Dolphin Tasks"
        assert result.workspace_path == str((root / "dolphin-tasks").resolve())
        assert "Dolphin" in result.placement_reason
        assert result.placement_confidence >= 60
        assert task.project_id == "dolphin"
        assert workflow is not None
        assert workflow.placement_kind == "matched_project"
        assert workflow.placement_project_id == "dolphin"
        assert workflow.cleanup_status == "not_applicable"
        assert created[0][0] == (root / "dolphin-tasks").resolve()
        assert sent[0][0] == (root / "dolphin-tasks").resolve()


@pytest.mark.asyncio
async def test_ambiguous_inbox_launch_uses_one_isolated_managed_workspace(
    tmp_path,
    monkeypatch,
):
    from app import task_workflow_service as service

    root = tmp_path / "projects"
    monkeypatch.setenv("DOLPHIN_WORKSPACE_ROOTS", str(root))
    _, created, sent = _mock_tmux(monkeypatch, service)

    async with _temporary_db(tmp_path) as db:
        task = await _seed_inbox_task(
            db,
            root,
            title="Plan a surprise birthday dinner",
            description="Compare menus and coordinate guests.",
        )

        first = await service.launch_task_research(db, task.id)
        second = await service.launch_task_research(db, task.id)
        workflow = await db.get(TaskWorkflow, task.id)

        workspace = Path(first.workspace_path)
        assert first.placement_kind == "temporary"
        assert first.project_id == service.MANAGED_TEMP_PROJECT_ID
        assert first.project_name == "Temporary workspace"
        assert ".dolphin-task-workspaces/active" in workspace.as_posix()
        assert workspace.is_dir()
        assert (workspace / "AGENTS.md").is_file()
        assert (workspace / "TASK.md").is_file()
        assert first.cleanup_status == "active"
        assert second.session_name == first.session_name
        assert second.reused is True
        assert len(created) == 1
        assert len(sent) == 1
        assert workflow is not None
        assert workflow.placement_workspace_path == str(workspace)
        assert workflow.placement_kind == "temporary"
        assert workflow.cleanup_status == "active"


@pytest.mark.asyncio
async def test_temporary_workspace_archives_only_after_done_closes_session(
    tmp_path,
    monkeypatch,
):
    from app import task_workflow_service as service

    root = tmp_path / "projects"
    monkeypatch.setenv("DOLPHIN_WORKSPACE_ROOTS", str(root))
    live_sessions, _, _ = _mock_tmux(monkeypatch, service)

    async with _temporary_db(tmp_path) as db:
        task = await _seed_inbox_task(
            db,
            root,
            title="Plan a surprise birthday dinner",
        )
        launched = await service.launch_task_research(db, task.id)
        active_path = Path(launched.workspace_path)

        waiting = await service.archive_completed_temporary_workspace(db, task.id)
        assert waiting.cleanup_status == "waiting_for_done"
        assert launched.session_name in live_sessions
        assert active_path.is_dir()

        await service.set_task_workflow_state(db, task, "done")
        await db.commit()
        assert launched.session_name not in live_sessions
        archived = await service.archive_completed_temporary_workspace(db, task.id)
        assert archived.cleanup_status == "archived"
        assert archived.cleanup_completed_at is not None
        assert archived.cleanup_archive_path
        assert Path(archived.cleanup_archive_path).is_dir()
        assert not active_path.exists()

        restored = await service.restore_archived_temporary_workspace(db, task.id)
        assert restored.cleanup_status == "active"
        assert restored.cleanup_archive_path is None
        assert active_path.is_dir()


@pytest.mark.asyncio
async def test_done_closes_exact_task_session_before_temporary_workspace_archive(
    tmp_path,
    monkeypatch,
):
    from app import task_workflow_service as service

    root = tmp_path / "projects"
    monkeypatch.setenv("DOLPHIN_WORKSPACE_ROOTS", str(root))
    live_sessions, _, _ = _mock_tmux(monkeypatch, service)
    closed: list[tuple[Path, str]] = []

    async def kill(path: Path, name: str):
        closed.append((path, name))
        live_sessions.pop(name)

    monkeypatch.setattr(service.tmux_service, "kill_session", kill)

    async with _temporary_db(tmp_path) as db:
        task = await _seed_inbox_task(
            db,
            root,
            title="Plan a surprise birthday dinner",
        )
        launched = await service.launch_task_research(db, task.id)
        active_path = Path(launched.workspace_path)
        other_workspace = root / "other"
        other_workspace.mkdir()
        live_sessions["dolphin-unrelated"] = _session(
            "dolphin-unrelated",
            other_workspace,
        )

        await service.set_task_workflow_state(db, task, "done")
        await db.commit()
        archived = await service.archive_completed_temporary_workspace(db, task.id)

        assert closed == [(active_path.resolve(), launched.session_name)]
        assert launched.session_name not in live_sessions
        assert "dolphin-unrelated" in live_sessions
        assert archived.cleanup_status == "archived"
        assert archived.cleanup_completed_at is not None
        assert archived.cleanup_archive_path
        assert Path(archived.cleanup_archive_path).is_dir()
        assert not active_path.exists()


@pytest.mark.asyncio
async def test_done_closes_exact_session_but_preserves_user_owned_project(
    tmp_path,
    monkeypatch,
):
    from app import task_workflow_service as service

    root = tmp_path / "projects"
    workspace = root / "explicit-project"
    workspace.mkdir(parents=True)
    marker = workspace / "user-owned.txt"
    marker.write_text("preserve me")
    monkeypatch.setenv("DOLPHIN_WORKSPACE_ROOTS", str(root))
    live_sessions, _, _ = _mock_tmux(monkeypatch, service)
    closed: list[tuple[Path, str]] = []

    async def kill(path: Path, name: str):
        closed.append((path, name))
        live_sessions.pop(name)

    monkeypatch.setattr(service.tmux_service, "kill_session", kill)

    async with _temporary_db(tmp_path) as db:
        project = Project(
            id="explicit-project",
            name="Explicit Project",
            path=str(workspace),
            position=0,
        )
        task = Task(
            id="task-explicit-abcdef12",
            project_id=project.id,
            title="Research the explicit project",
            priority=1,
            position=0,
        )
        db.add_all([project, task])
        await db.commit()

        launched = await service.launch_task_research(db, task.id)
        expected_session = service.make_task_session_name(
            project_name=project.name,
            task_title=task.title,
            task_id=task.id,
        )
        other_workspace = root / "other"
        other_workspace.mkdir()
        live_sessions["dolphin-unrelated"] = _session(
            "dolphin-unrelated",
            other_workspace,
        )

        workflow = await service.set_task_workflow_state(db, task, "done")
        await service.set_task_workflow_state(db, task, "done")
        await db.commit()

        assert launched.placement_kind == "explicit_project"
        assert launched.session_name == expected_session
        assert closed == [(workspace.resolve(), expected_session)]
        assert expected_session not in live_sessions
        assert "dolphin-unrelated" in live_sessions
        assert workspace.is_dir()
        assert marker.read_text() == "preserve me"
        assert workflow.cleanup_status == "not_applicable"


@pytest.mark.asyncio
async def test_done_uses_project_path_for_preplacement_linked_session(
    tmp_path,
    monkeypatch,
):
    from app import task_workflow_service as service

    root = tmp_path / "projects"
    workspace = root / "legacy-project"
    workspace.mkdir(parents=True)
    monkeypatch.setenv("DOLPHIN_WORKSPACE_ROOTS", str(root))
    live_sessions, _, _ = _mock_tmux(monkeypatch, service)
    closed: list[tuple[Path, str]] = []

    async def kill(path: Path, name: str):
        closed.append((path, name))
        live_sessions.pop(name)

    monkeypatch.setattr(service.tmux_service, "kill_session", kill)

    async with _temporary_db(tmp_path) as db:
        project = Project(
            id="legacy-project",
            name="Legacy Project",
            path=str(workspace),
            position=0,
        )
        task = Task(
            id="task-legacy-abcdef12",
            project_id=project.id,
            title="Research the legacy project",
            priority=1,
            position=0,
        )
        session_name = service.make_task_session_name(
            project_name=project.name,
            task_title=task.title,
            task_id=task.id,
        )
        workflow = TaskWorkflow(
            task_id=task.id,
            state="in_progress",
            session_name=session_name,
            research_status="researching",
            cleanup_status="not_applicable",
        )
        db.add_all([project, task, workflow])
        await db.commit()
        live_sessions[session_name] = _session(session_name, workspace)

        await service.set_task_workflow_state(db, task, "done")
        await db.commit()

        assert closed == [(workspace.resolve(), session_name)]
        assert session_name not in live_sessions
        assert workspace.is_dir()


@pytest.mark.asyncio
async def test_done_refuses_to_close_non_deterministic_workflow_session(
    tmp_path,
    monkeypatch,
):
    from app import task_workflow_service as service

    root = tmp_path / "projects"
    workspace = root / "guarded-project"
    workspace.mkdir(parents=True)
    monkeypatch.setenv("DOLPHIN_WORKSPACE_ROOTS", str(root))
    live_sessions, _, _ = _mock_tmux(monkeypatch, service)
    unrelated_name = "dolphin-unrelated"

    async with _temporary_db(tmp_path) as db:
        project = Project(
            id="guarded-project",
            name="Guarded Project",
            path=str(workspace),
            position=0,
        )
        task = Task(
            id="task-guarded-abcdef12",
            project_id=project.id,
            title="Research the guarded project",
            priority=1,
            position=0,
        )
        workflow = TaskWorkflow(
            task_id=task.id,
            state="in_progress",
            session_name=unrelated_name,
            research_status="researching",
            placement_workspace_path=str(workspace),
            cleanup_status="not_applicable",
        )
        db.add_all([project, task, workflow])
        await db.commit()
        live_sessions[unrelated_name] = _session(unrelated_name, workspace)

        await service.set_task_workflow_state(db, task, "done")
        await db.commit()

        assert unrelated_name in live_sessions
        assert workspace.is_dir()


@pytest.mark.asyncio
async def test_user_owned_project_is_never_eligible_for_workspace_archival(
    tmp_path,
    monkeypatch,
):
    from app import task_workflow_service as service

    root = tmp_path / "projects"
    monkeypatch.setenv("DOLPHIN_WORKSPACE_ROOTS", str(root))
    _mock_tmux(monkeypatch, service)

    async with _temporary_db(tmp_path) as db:
        task = await _seed_inbox_task(
            db,
            root,
            title="Polish Dolphin agent kanban inline capture",
        )
        launched = await service.launch_task_research(db, task.id)
        await service.set_task_workflow_state(db, task, "done")
        await db.commit()

        workflow = await service.archive_completed_temporary_workspace(db, task.id)
        assert launched.placement_kind == "matched_project"
        assert workflow.cleanup_status == "not_applicable"
        assert (root / "dolphin-tasks").is_dir()
