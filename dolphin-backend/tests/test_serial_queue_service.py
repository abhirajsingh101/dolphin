import importlib
import hashlib
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

import pytest
from fastapi.routing import APIRoute
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.database import Base
from app.models import Project, Task, TaskQualityContract, TaskWorkflow
from app.tmux_service import TmuxServiceError, TmuxSessionInfo


def _load_service():
    return importlib.import_module("app.serial_queue_service")


@asynccontextmanager
async def _temporary_db(tmp_path: Path):
    engine = create_async_engine(
        f"sqlite+aiosqlite:///{tmp_path / 'serial-queue.db'}"
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


async def _seed_project_tasks(
    db: AsyncSession,
    workspace: Path,
) -> tuple[Project, list[Task]]:
    project = Project(
        id="project-alpha",
        name="Alpha Robot",
        path=str(workspace),
        color="#176B87",
        position=0,
    )
    tasks = [
        Task(
            id="task-first",
            project_id=project.id,
            title="Calibrate the arm",
            description="Verify the calibration tests.",
            priority=1,
            position=0,
        ),
        Task(
            id="task-second",
            project_id=project.id,
            title="Document the offsets",
            description="Update the operator notes.",
            priority=2,
            position=1,
        ),
        Task(
            id="task-third",
            project_id=project.id,
            title="Add the safety check",
            description="Fail closed when calibration is missing.",
            priority=1,
            position=2,
        ),
    ]
    db.add_all([project, *tasks])
    await db.commit()
    return project, tasks


def test_serial_queue_prompt_uses_exact_order_and_durable_completion_gate():
    service = _load_service()

    prompt = service.build_serial_queue_prompt(
        queue_id="queue-123",
        project_id="project-alpha",
        project_name="Alpha Robot",
        workspace_path="/work/alpha",
        tasks=[
            service.SerialQueueTask(
                id="task-second",
                title="Document the offsets",
                description="Update the operator notes.",
            ),
            service.SerialQueueTask(
                id="task-first",
                title="Calibrate the arm",
                description="Verify the calibration tests.",
            ),
        ],
    )

    assert "\n" not in prompt
    assert prompt.index("task-second") < prompt.index("task-first")
    assert "exact order" in prompt.lower()
    assert "exactly one task at a time" in prompt.lower()
    assert "/api/projects/project-alpha/execution-queue" in prompt
    assert "/api/tasks/<task_id>" in prompt
    assert '"is_done":true' in prompt
    assert "only work on the item marked `running`" in prompt.lower()
    assert "explicitly started" in prompt


def test_serial_queue_quality_task_waits_for_independent_acceptance():
    service = _load_service()
    prompt = service.build_serial_queue_prompt(
        queue_id="queue-quality",
        project_id="project-alpha",
        project_name="Alpha Robot",
        workspace_path="/work/alpha",
        tasks=[
            service.SerialQueueTask(
                id="task-quality",
                title="Governed queue task",
                execution_prompt="Implement and verify the governed queue task.",
                origin="dolphin",
                quality_governed=True,
            )
        ],
    )

    assert '"quality_governed":true' in prompt
    assert "/quality/transition" in prompt
    assert "/quality/evidence" in prompt
    assert "Never review your own receipt or PUT the task Done" in prompt


def test_serial_queue_prompt_preserves_each_frozen_execution_prompt():
    service = _load_service()
    exact = "Implement the queue slice.\n\nPreserve  this spacing."

    prompt = service.build_serial_queue_prompt(
        queue_id="queue-123",
        project_id="project-alpha",
        project_name="Alpha Robot",
        workspace_path="/work/alpha",
        tasks=[
            service.SerialQueueTask(
                id="task-first",
                title="Queue label",
                execution_prompt=exact,
                origin="dolphin",
            )
        ],
    )

    assert exact.replace("\n", "\\n") in prompt
    assert "Preserve  this spacing" in prompt
    assert hashlib.sha256(exact.encode("utf-8")).hexdigest() in prompt
    assert '"origin":"dolphin"' in prompt
    assert "execution_prompt is the frozen exact work instruction" in prompt


def test_serial_queue_routes_are_project_scoped_and_typed():
    main = importlib.import_module("app.main")
    schemas = importlib.import_module("app.schemas")
    routes = {
        (next(iter(route.methods)), route.response_model)
        for route in main.app.routes
        if isinstance(route, APIRoute)
        and route.path == "/api/projects/{project_id}/execution-queue"
    }

    assert routes == {
        ("GET", schemas.SerialQueueResponse),
        ("POST", schemas.SerialQueueResponse),
        ("DELETE", schemas.SerialQueueResponse),
    }


@pytest.mark.asyncio
async def test_start_queue_persists_order_before_one_dedicated_codex_launch(
    tmp_path,
    monkeypatch,
):
    service = _load_service()
    workspace = tmp_path / "projects" / "alpha"
    workspace.mkdir(parents=True)
    monkeypatch.setenv("DOLPHIN_WORKSPACE_ROOTS", str(tmp_path / "projects"))
    events: list[tuple] = []

    async def fake_create(
        path: Path,
        project_name: str,
        requested_name: str | None = None,
        mode: str = "shell",
    ):
        events.append(("create", path, project_name, requested_name, mode))
        assert requested_name is not None
        return _session(requested_name, path)

    async def fake_start_codex(
        path: Path,
        name: str,
        initial_prompt: str | None = None,
    ):
        events.append(("start_codex", path, name, initial_prompt))

    async def unexpected_send(*_args, **_kwargs):
        raise AssertionError("Fresh serial Codex startup must carry its own prompt")

    monkeypatch.setattr(service.tmux_service, "create_session", fake_create)
    monkeypatch.setattr(service.tmux_service, "start_codex", fake_start_codex)
    monkeypatch.setattr(service.tmux_service, "send_input", unexpected_send)

    async with _temporary_db(tmp_path) as db:
        _project, seeded_tasks = await _seed_project_tasks(db, workspace)
        quality_task = next(task for task in seeded_tasks if task.id == "task-second")
        db.add(
            TaskQualityContract(
                task_id=quality_task.id,
                project_id=quality_task.project_id,
                desired_outcome="The offsets are documented and verified.",
                risk_level="medium",
                stage="plan",
                acceptance_checks_json=(
                    '[{"id":"verified","description":"Offsets verified"}]'
                ),
                required_skills_json="[]",
                human_review_required=True,
                revision=1,
            )
        )
        await db.commit()

        result = await service.start_serial_queue(
            db,
            "project-alpha",
            ["task-second", "task-first", "task-third"],
        )

        project = await db.get(Project, "project-alpha")
        workflows = list(
            (
                await db.execute(
                    select(TaskWorkflow)
                    .where(TaskWorkflow.serial_queue_id == result.queue_id)
                    .order_by(TaskWorkflow.serial_queue_position)
                )
            )
            .scalars()
            .all()
        )

    assert result.status == "running"
    assert result.session_name.startswith("dolphin-serial-alpha-robot-")
    assert [item.task_id for item in result.items] == [
        "task-second",
        "task-first",
        "task-third",
    ]
    assert [item.status for item in result.items] == [
        "running",
        "queued",
        "queued",
    ]
    assert project is not None
    assert project.serial_queue_id == result.queue_id
    assert project.serial_queue_status == "running"
    assert [workflow.serial_queue_position for workflow in workflows] == [0, 1, 2]
    assert [workflow.serial_queue_status for workflow in workflows] == [
        "running",
        "queued",
        "queued",
    ]
    assert [workflow.state for workflow in workflows] == [
        "in_progress",
        "todo",
        "todo",
    ]
    assert [event[0] for event in events] == ["create", "start_codex"]
    assert events[0][4] == "shell"
    assert events[1][1:3] == (workspace.resolve(), result.session_name)
    assert events[1][3] is not None
    assert "task-second" in events[1][3]
    assert '"quality_governed":true' in events[1][3]
    assert "/quality/transition" in events[1][3]
    assert "/quality/evidence" in events[1][3]


@pytest.mark.asyncio
async def test_control_center_snapshot_reconstructs_the_durable_queue(
    tmp_path,
    monkeypatch,
):
    control_center = importlib.import_module("app.control_center_service")
    workflow_service = importlib.import_module("app.task_workflow_service")
    workspace = tmp_path / "projects" / "alpha"
    workspace.mkdir(parents=True)
    monkeypatch.setenv("DOLPHIN_WORKSPACE_ROOTS", str(tmp_path / "projects"))

    async def no_sessions():
        return []

    monkeypatch.setattr(control_center.tmux_service, "list_all_sessions", no_sessions)

    async with _temporary_db(tmp_path) as db:
        project, tasks = await _seed_project_tasks(db, workspace)
        project.serial_queue_id = "queue-visible"
        project.serial_queue_status = "running"
        project.serial_queue_session_name = "dolphin-serial-alpha-visible"
        workflow = await workflow_service.get_or_create_workflow(db, tasks[0])
        workflow.state = "in_progress"
        workflow.serial_queue_id = project.serial_queue_id
        workflow.serial_queue_position = 0
        workflow.serial_queue_status = "running"
        await db.commit()

        snapshot = await control_center.build_control_center(db)

    projected_project = next(
        item for item in snapshot.projects if item.id == project.id
    )
    projected_task = next(
        item for item in projected_project.tasks if item.id == tasks[0].id
    )
    assert projected_project.serial_queue_status == "running"
    assert (
        projected_project.serial_queue_session_name
        == "dolphin-serial-alpha-visible"
    )
    assert projected_task.workflow_state == "in_progress"
    assert projected_task.serial_queue_status == "running"
    assert projected_task.serial_queue_position == 0


@pytest.mark.asyncio
async def test_done_transition_advances_only_the_next_queued_task(tmp_path):
    service = _load_service()
    workflow_service = importlib.import_module("app.task_workflow_service")
    workspace = tmp_path / "projects" / "alpha"
    workspace.mkdir(parents=True)

    async with _temporary_db(tmp_path) as db:
        project, tasks = await _seed_project_tasks(db, workspace)
        project.serial_queue_id = "queue-123"
        project.serial_queue_status = "running"
        project.serial_queue_session_name = "dolphin-serial-alpha-queue-123"
        for position, task in enumerate(tasks):
            workflow = await workflow_service.get_or_create_workflow(db, task)
            workflow.serial_queue_id = "queue-123"
            workflow.serial_queue_position = position
            workflow.serial_queue_status = "running" if position == 0 else "queued"
            workflow.serial_queue_enqueued_at = datetime.now(timezone.utc)
        await db.commit()

        await workflow_service.set_task_workflow_state(db, tasks[0], "done")
        await db.commit()
        await db.refresh(project)
        first = await db.get(TaskWorkflow, tasks[0].id)
        second = await db.get(TaskWorkflow, tasks[1].id)
        third = await db.get(TaskWorkflow, tasks[2].id)

        assert first is not None and first.serial_queue_status == "completed"
        assert second is not None and second.serial_queue_status == "running"
        assert second.serial_queue_started_at is not None
        assert second.state == "in_progress"
        assert third is not None and third.serial_queue_status == "queued"
        assert project.serial_queue_status == "running"

        await workflow_service.set_task_workflow_state(db, tasks[1], "done")
        await workflow_service.set_task_workflow_state(db, tasks[2], "done")
        await db.commit()
        await db.refresh(project)

        assert project.serial_queue_status == "completed"
        assert project.serial_queue_error is None


@pytest.mark.asyncio
async def test_quality_acceptance_pauses_serial_queue_before_the_next_task(tmp_path):
    service = _load_service()
    workflow_service = importlib.import_module("app.task_workflow_service")
    workspace = tmp_path / "projects" / "alpha"
    workspace.mkdir(parents=True)

    async with _temporary_db(tmp_path) as db:
        project, tasks = await _seed_project_tasks(db, workspace)
        project.serial_queue_id = "queue-quality"
        project.serial_queue_status = "running"
        project.serial_queue_session_name = "dolphin-serial-alpha-quality"
        workflows: list[TaskWorkflow] = []
        for position, task in enumerate(tasks[:2]):
            workflow = await workflow_service.get_or_create_workflow(db, task)
            workflow.serial_queue_id = "queue-quality"
            workflow.serial_queue_position = position
            workflow.serial_queue_status = "running" if position == 0 else "queued"
            workflow.state = "in_progress" if position == 0 else "todo"
            workflows.append(workflow)
        db.add(
            TaskQualityContract(
                task_id=tasks[0].id,
                project_id=project.id,
                desired_outcome="The first task is independently accepted.",
                risk_level="medium",
                stage="done",
                acceptance_checks_json='[{"id":"done","description":"Done"}]',
                required_skills_json="[]",
                human_review_required=True,
                revision=1,
            )
        )
        tasks[0].is_done = True
        workflows[0].state = "done"
        await service.advance_serial_queue_for_done_task(
            db,
            tasks[0],
            workflows[0],
        )
        await db.commit()
        await db.refresh(project)
        await db.refresh(workflows[1])

        assert project.serial_queue_status == "paused"
        assert "Cancel this paused queue" in (project.serial_queue_error or "")
        assert "start the remaining Todos" in (project.serial_queue_error or "")
        assert workflows[1].serial_queue_status == "queued"
        assert workflows[1].state == "todo"


@pytest.mark.asyncio
async def test_cancelled_queue_never_advances_remaining_tasks(tmp_path):
    service = _load_service()
    workflow_service = importlib.import_module("app.task_workflow_service")
    workspace = tmp_path / "projects" / "alpha"
    workspace.mkdir(parents=True)

    async with _temporary_db(tmp_path) as db:
        project, tasks = await _seed_project_tasks(db, workspace)
        project.serial_queue_id = "queue-cancel"
        project.serial_queue_status = "running"
        project.serial_queue_session_name = "dolphin-serial-alpha-cancel"
        for position, task in enumerate(tasks[:2]):
            workflow = await workflow_service.get_or_create_workflow(db, task)
            workflow.serial_queue_id = "queue-cancel"
            workflow.serial_queue_position = position
            workflow.serial_queue_status = "running" if position == 0 else "queued"
        await db.commit()

        cancelled = await service.cancel_serial_queue(db, project.id)
        await workflow_service.set_task_workflow_state(db, tasks[0], "done")
        await db.commit()

        second = await db.get(TaskWorkflow, tasks[1].id)
        await db.refresh(project)

    assert cancelled.status == "cancelled"
    assert project.serial_queue_status == "cancelled"
    assert second is not None and second.serial_queue_status == "cancelled"


@pytest.mark.asyncio
async def test_cross_project_or_non_todo_selection_fails_before_tmux(
    tmp_path,
    monkeypatch,
):
    service = _load_service()
    workflow_service = importlib.import_module("app.task_workflow_service")
    workspace = tmp_path / "projects" / "alpha"
    workspace.mkdir(parents=True)
    other_workspace = tmp_path / "projects" / "other"
    other_workspace.mkdir()
    monkeypatch.setenv("DOLPHIN_WORKSPACE_ROOTS", str(tmp_path / "projects"))

    async def unexpected_create(*_args, **_kwargs):
        raise AssertionError("Invalid queue selection must not touch tmux")

    monkeypatch.setattr(service.tmux_service, "create_session", unexpected_create)

    async with _temporary_db(tmp_path) as db:
        _, tasks = await _seed_project_tasks(db, workspace)
        other = Project(
            id="project-other",
            name="Other",
            path=str(other_workspace),
            position=1,
        )
        foreign_task = Task(
            id="task-foreign",
            project_id=other.id,
            title="Foreign task",
            position=0,
        )
        db.add_all([other, foreign_task])
        workflow = await workflow_service.get_or_create_workflow(db, tasks[0])
        workflow.state = "review"
        await db.commit()

        with pytest.raises(service.SerialQueueError, match="same project"):
            await service.start_serial_queue(
                db,
                "project-alpha",
                ["task-second", "task-foreign"],
            )
        with pytest.raises(service.SerialQueueError, match="Todo"):
            await service.start_serial_queue(
                db,
                "project-alpha",
                ["task-first"],
            )


@pytest.mark.asyncio
async def test_task_with_existing_research_dispatch_fails_before_tmux(
    tmp_path,
    monkeypatch,
):
    service = _load_service()
    workflow_service = importlib.import_module("app.task_workflow_service")
    workspace = tmp_path / "projects" / "alpha"
    workspace.mkdir(parents=True)
    monkeypatch.setenv("DOLPHIN_WORKSPACE_ROOTS", str(tmp_path / "projects"))

    async def unexpected_create(*_args, **_kwargs):
        raise AssertionError("A previously dispatched task must not touch tmux")

    monkeypatch.setattr(service.tmux_service, "create_session", unexpected_create)

    async with _temporary_db(tmp_path) as db:
        _, tasks = await _seed_project_tasks(db, workspace)
        workflow = await workflow_service.get_or_create_workflow(db, tasks[0])
        workflow.session_name = "dolphin-alpha-existing"
        workflow.research_status = "researching"
        workflow.prompt_sent_at = datetime.now(timezone.utc)
        await db.commit()

        with pytest.raises(service.SerialQueueError, match="research session"):
            await service.start_serial_queue(
                db,
                "project-alpha",
                ["task-first"],
            )


@pytest.mark.asyncio
async def test_launch_failure_pauses_queue_without_starting_later_items(
    tmp_path,
    monkeypatch,
):
    service = _load_service()
    workspace = tmp_path / "projects" / "alpha"
    workspace.mkdir(parents=True)
    monkeypatch.setenv("DOLPHIN_WORKSPACE_ROOTS", str(tmp_path / "projects"))

    async def fail_create(*_args, **_kwargs):
        raise TmuxServiceError("Codex could not start", 503)

    monkeypatch.setattr(service.tmux_service, "create_session", fail_create)

    async with _temporary_db(tmp_path) as db:
        await _seed_project_tasks(db, workspace)

        with pytest.raises(service.SerialQueueError, match="Codex could not start"):
            await service.start_serial_queue(
                db,
                "project-alpha",
                ["task-first", "task-second"],
            )

        project = await db.get(Project, "project-alpha")
        workflows = list(
            (
                await db.execute(
                    select(TaskWorkflow)
                    .where(TaskWorkflow.serial_queue_id == project.serial_queue_id)
                    .order_by(TaskWorkflow.serial_queue_position)
                )
            )
            .scalars()
            .all()
        )

    assert project is not None
    assert project.serial_queue_status == "paused"
    assert "Codex could not start" in (project.serial_queue_error or "")
    assert [workflow.serial_queue_status for workflow in workflows] == [
        "failed",
        "queued",
    ]
