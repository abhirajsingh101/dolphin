from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app import main
from app.database import Base
from app.models import Project, Task, TaskWorkflow
from app.schemas import TmuxSessionRename
from app.tmux_service import TmuxSessionInfo


@pytest.fixture(autouse=True)
def _allow_test_workspace(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("DOLPHIN_WORKSPACE_ROOTS", str(tmp_path))


@asynccontextmanager
async def _temporary_db(tmp_path: Path):
    engine = create_async_engine(
        f"sqlite+aiosqlite:///{tmp_path / 'tmux-session-rename.db'}"
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


def _session(name: str, workspace: Path) -> TmuxSessionInfo:
    return TmuxSessionInfo(
        name=name,
        path=str(workspace.resolve()),
        created_at=datetime.now(timezone.utc),
        windows=1,
        attached=False,
        current_command="bash",
        is_codex_running=False,
    )


async def _seed_owned_sessions(
    db: AsyncSession,
    workspace: Path,
) -> tuple[Project, str, str]:
    task_session_name = "dolphin-task-owned-12345678"
    queue_session_name = "dolphin-serial-dolphin-tasks-87654321"
    project = Project(
        id="project-1",
        name="Dolphin Tasks",
        path=str(workspace),
        color="#176B87",
        position=0,
        serial_queue_session_name=queue_session_name,
    )
    task = Task(
        id="task-1",
        project_id=project.id,
        title="Owned task",
        position=0,
    )
    workflow = TaskWorkflow(
        task_id=task.id,
        state="in_progress",
        session_name=task_session_name,
        research_status="researching",
    )
    db.add_all([project, task, workflow])
    await db.commit()
    return project, task_session_name, queue_session_name


@pytest.mark.asyncio
async def test_workspace_marks_task_and_queue_sessions_non_renamable(
    tmp_path,
    monkeypatch,
):
    workspace = tmp_path / "project"
    workspace.mkdir()

    async with _temporary_db(tmp_path) as db:
        project, task_name, queue_name = await _seed_owned_sessions(db, workspace)
        sessions = [
            _session("manual-dolphin", workspace),
            _session(task_name, workspace),
            _session(queue_name, workspace),
        ]

        async def fake_list_workspace_sessions(_workspace_path):
            return sessions

        monkeypatch.setattr(
            main,
            "list_workspace_sessions",
            fake_list_workspace_sessions,
        )

        response = await main.get_project_workspace(project.id, db)

    by_name = {session.name: session for session in response.sessions}
    assert by_name["manual-dolphin"].rename_allowed is True
    assert by_name["manual-dolphin"].rename_block_reason is None
    assert by_name[task_name].rename_allowed is False
    assert "task-owned" in by_name[task_name].rename_block_reason
    assert by_name[queue_name].rename_allowed is False
    assert "serial-queue-owned" in by_name[queue_name].rename_block_reason


@pytest.mark.asyncio
@pytest.mark.parametrize("owner_kind", ["task", "queue"])
async def test_route_rejects_renaming_managed_session_before_tmux_mutation(
    tmp_path,
    monkeypatch,
    owner_kind,
):
    workspace = tmp_path / "project"
    workspace.mkdir()

    async with _temporary_db(tmp_path) as db:
        project, task_name, queue_name = await _seed_owned_sessions(db, workspace)
        old_name = task_name if owner_kind == "task" else queue_name

        async def reject_rename(*_args, **_kwargs):
            raise AssertionError("Managed session rename must not reach tmux.")

        monkeypatch.setattr(main, "rename_session", reject_rename)

        with pytest.raises(HTTPException) as error:
            await main.rename_project_tmux_session(
                project.id,
                old_name,
                TmuxSessionRename(name="new-title"),
                db,
            )

    assert error.value.status_code == 409
    assert f"{owner_kind}-owned" in error.value.detail


@pytest.mark.asyncio
async def test_route_rejects_managed_final_name_reserved_for_future_reuse(
    tmp_path,
    monkeypatch,
):
    workspace = tmp_path / "project"
    workspace.mkdir()

    async with _temporary_db(tmp_path) as db:
        project, task_name, _queue_name = await _seed_owned_sessions(db, workspace)

        async def reject_rename(*_args, **_kwargs):
            raise AssertionError("A managed final name must not reach tmux.")

        monkeypatch.setattr(main, "rename_session", reject_rename)

        with pytest.raises(HTTPException) as error:
            await main.rename_project_tmux_session(
                project.id,
                "manual-dolphin",
                TmuxSessionRename(name=task_name),
                db,
            )

    assert error.value.status_code == 409
    assert "reserved by a task-owned session" in error.value.detail


@pytest.mark.asyncio
async def test_route_renames_manual_session_and_returns_eligibility(
    tmp_path,
    monkeypatch,
):
    workspace = tmp_path / "project"
    workspace.mkdir()
    renamed = _session("release-dolphin", workspace)
    calls: list[tuple[Path, str, str, str]] = []

    async with _temporary_db(tmp_path) as db:
        project, _task_name, _queue_name = await _seed_owned_sessions(db, workspace)

        async def fake_rename_session(
            workspace_path,
            project_name,
            old_name,
            requested_name,
        ):
            calls.append(
                (workspace_path, project_name, old_name, requested_name)
            )
            return renamed

        monkeypatch.setattr(main, "rename_session", fake_rename_session)

        response = await main.rename_project_tmux_session(
            project.id,
            "manual-dolphin",
            TmuxSessionRename(name="release"),
            db,
        )

    assert calls == [
        (workspace.resolve(), "Dolphin Tasks", "manual-dolphin", "release")
    ]
    assert response.name == "release-dolphin"
    assert response.rename_allowed is True
    assert response.rename_block_reason is None


@pytest.mark.asyncio
async def test_list_sessions_keeps_project_identity_for_rename_restrictions(
    tmp_path,
    monkeypatch,
):
    workspace = tmp_path / "project"
    workspace.mkdir()

    async with _temporary_db(tmp_path) as db:
        project, task_name, _queue_name = await _seed_owned_sessions(db, workspace)

        async def fake_list_workspace_sessions(_workspace_path):
            return [
                _session("manual-dolphin", workspace),
                _session(task_name, workspace),
            ]

        monkeypatch.setattr(
            main,
            "list_workspace_sessions",
            fake_list_workspace_sessions,
        )

        response = await main.get_project_tmux_sessions(project.id, db)

    by_name = {session.name: session for session in response}
    assert by_name["manual-dolphin"].rename_allowed is True
    assert by_name[task_name].rename_allowed is False
    assert "task-owned" in by_name[task_name].rename_block_reason
