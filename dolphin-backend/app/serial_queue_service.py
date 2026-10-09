"""Durable, project-scoped serial execution queues for Codex."""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from . import tmux_service
from .models import Project, Task, TaskQualityContract, TaskWorkflow


PROJECT_QUEUE_STATUSES = frozenset(
    {"idle", "running", "paused", "completed", "cancelled"}
)
TASK_QUEUE_STATUSES = frozenset(
    {"not_queued", "queued", "running", "completed", "cancelled", "failed"}
)
ACTIVE_PROJECT_QUEUE_STATUSES = frozenset({"running", "paused"})
MAX_SERIAL_QUEUE_TASKS = 50
_PROJECT_LOCKS: dict[str, asyncio.Lock] = {}
# Bounded cleanup of a project's previous queue metadata.
_METADATA_BATCH_SIZE = 64
_METADATA_MAX_SCAN_ROWS = 20_000


class SerialQueueError(Exception):
    """A user-visible queue error whose durable state is already safe."""

    def __init__(self, detail: str, status_code: int = 409):
        super().__init__(detail)
        self.detail = detail
        self.status_code = status_code


@dataclass(frozen=True)
class SerialQueueTask:
    id: str
    title: str
    description: str = ""
    execution_prompt: str = ""
    origin: str = "human"
    quality_governed: bool = False


@dataclass(frozen=True)
class SerialQueueItemResult:
    task_id: str
    title: str
    position: int
    status: str
    error: str | None
    enqueued_at: datetime | None
    started_at: datetime | None
    completed_at: datetime | None


@dataclass(frozen=True)
class SerialQueueResult:
    project_id: str
    queue_id: str | None
    status: str
    session_name: str | None
    error: str | None
    created_at: datetime | None
    updated_at: datetime | None
    items: tuple[SerialQueueItemResult, ...]


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.strip().lower()).strip("-")
    return slug[:36] or "project"


def make_serial_queue_session_name(project_name: str, queue_id: str) -> str:
    return f"dolphin-serial-{_slugify(project_name)}-{queue_id[:8]}"[:80]


def build_serial_queue_prompt(
    *,
    queue_id: str,
    project_id: str,
    project_name: str,
    workspace_path: str,
    tasks: list[SerialQueueTask],
    api_base: str = "http://127.0.0.1:8400",
) -> str:
    task_payload = [
        {
            "id": task.id,
            "title": task.title,
            "description": task.description,
            "origin": task.origin,
            "execution_prompt": (
                task.execution_prompt or task.description or task.title
            ),
            "execution_prompt_sha256": hashlib.sha256(
                (task.execution_prompt or task.description or task.title).encode(
                    "utf-8"
                )
            ).hexdigest(),
            "quality_governed": task.quality_governed,
        }
        for task in tasks
    ]
    encoded_tasks = json.dumps(
        task_payload,
        ensure_ascii=True,
        separators=(",", ":"),
    )
    queue_url = f"{api_base}/api/projects/{project_id}/execution-queue"
    prompt = (
        "Dolphin Tasks project serial execution queue. "
        "The user explicitly started this queue, which authorizes implementation "
        "and verification for only the listed tasks within the stated workspace. "
        f"Queue id: {queue_id}. Project: {project_name}. "
        f"Workspace: {workspace_path}. Tasks in exact order JSON: {encoded_tasks}. "
        "For every running item, execution_prompt is the frozen exact work "
        "instruction; follow it verbatim in meaning and scope, and treat title and "
        "description only as supporting metadata. "
        "Follow every applicable AGENTS.md and preserve unrelated user changes. "
        "Work on exactly one task at a time and keep the exact order. "
        f"Before starting each task, GET {queue_url}. "
        "Only work on the item marked `running`; never start an item marked "
        "`queued`, and stop if the project queue is paused or cancelled. "
        "Inspect the current repository state and complete the running task "
        "end to end, including relevant verification. "
        "If a task is ambiguous, unsafe, blocked, or needs human input, stop "
        "without marking it done and report NEEDS HUMAN with the concrete blocker. "
        "For quality_governed=true, GET /api/tasks/<task_id>/quality, advance only "
        "the current contract stage through /quality/transition, and submit structured "
        "evidence for every acceptance check through /quality/evidence. Never review "
        "your own receipt or PUT the task Done; stop at Review. Independent acceptance "
        "marks it Done and safely pauses this serial queue before the next item. The "
        "human must cancel the paused queue and explicitly start the remaining Todos "
        "as a new queue. For quality_governed=false only, mark "
        "the verified task Done with: curl -sS -X PUT -H 'Content-Type: application/json' "
        f"-d '{{\"is_done\":true}}' {api_base}/api/tasks/<task_id>. "
        f"Then GET {queue_url} again and continue only with its next `running` "
        "item. Never mark multiple tasks done together or infer completion from "
        "terminal output. When the queue reports completed, summarize each task, "
        "its verification, changed files, and any remaining concerns."
    )
    return prompt


def _workflow_state(task: Task) -> str:
    workflow = task.__dict__.get("workflow")
    if workflow is not None and workflow.state in {
        "todo",
        "in_progress",
        "review",
        "done",
    }:
        return workflow.state
    return "done" if task.is_done else "todo"


async def _workflow_for(db: AsyncSession, task: Task) -> TaskWorkflow:
    loaded = task.__dict__.get("workflow")
    if loaded is not None:
        return loaded
    existing = await db.get(TaskWorkflow, task.id)
    if existing is not None:
        task.workflow = existing
        return existing
    workflow = TaskWorkflow(
        task_id=task.id,
        state="done" if task.is_done else "todo",
        research_status="idle",
    )
    task.workflow = workflow
    db.add(workflow)
    await db.flush()
    return workflow


async def _project_or_error(db: AsyncSession, project_id: str) -> Project:
    project = await db.get(Project, project_id)
    if project is None:
        raise SerialQueueError("Project not found.", 404)
    return project


async def get_serial_queue(
    db: AsyncSession,
    project_id: str,
) -> SerialQueueResult:
    project = await _project_or_error(db, project_id)
    queue_id = project.serial_queue_id
    items: list[SerialQueueItemResult] = []
    if queue_id:
        result = await db.execute(
            select(Task, TaskWorkflow)
            .join(TaskWorkflow, TaskWorkflow.task_id == Task.id)
            .where(
                Task.project_id == project.id,
                TaskWorkflow.serial_queue_id == queue_id,
            )
            .order_by(
                TaskWorkflow.serial_queue_position,
                Task.position,
                Task.created_at,
                Task.id,
            )
        )
        items = [
            SerialQueueItemResult(
                task_id=task.id,
                title=task.title,
                position=workflow.serial_queue_position or 0,
                status=workflow.serial_queue_status,
                error=workflow.serial_queue_error,
                enqueued_at=workflow.serial_queue_enqueued_at,
                started_at=workflow.serial_queue_started_at,
                completed_at=workflow.serial_queue_completed_at,
            )
            for task, workflow in result.all()
        ]
    return SerialQueueResult(
        project_id=project.id,
        queue_id=queue_id,
        status=project.serial_queue_status or "idle",
        session_name=project.serial_queue_session_name,
        error=project.serial_queue_error,
        created_at=project.serial_queue_created_at,
        updated_at=project.serial_queue_updated_at,
        items=tuple(items),
    )


async def _clear_previous_queue_metadata(
    db: AsyncSession,
    project_id: str,
) -> None:
    cursor: str | None = None
    scanned = 0
    metadata_present = or_(
        TaskWorkflow.serial_queue_id.is_not(None),
        TaskWorkflow.serial_queue_position.is_not(None),
        TaskWorkflow.serial_queue_error.is_not(None),
        TaskWorkflow.serial_queue_enqueued_at.is_not(None),
        TaskWorkflow.serial_queue_started_at.is_not(None),
        TaskWorkflow.serial_queue_completed_at.is_not(None),
        TaskWorkflow.serial_queue_status != "not_queued",
    )
    while True:
        criteria = [Task.project_id == project_id, metadata_present]
        if cursor is not None:
            criteria.append(Task.id > cursor)
        task_ids = list(
            (
                await db.scalars(
                    select(Task.id)
                    .join(TaskWorkflow, TaskWorkflow.task_id == Task.id)
                    .where(*criteria)
                    .order_by(Task.id)
                    .limit(_METADATA_BATCH_SIZE)
                )
            ).all()
        )
        if not task_ids:
            return
        scanned += len(task_ids)
        if scanned > _METADATA_MAX_SCAN_ROWS:
            raise SerialQueueError(
                "Serial queue metadata cleanup exceeded its bounded scan budget.",
                409,
            )
        for task_id in task_ids:
            cursor = task_id
            workflow = await db.get(TaskWorkflow, task_id)
            if workflow is None:
                continue
            workflow.serial_queue_id = None
            workflow.serial_queue_position = None
            workflow.serial_queue_status = "not_queued"
            workflow.serial_queue_error = None
            workflow.serial_queue_enqueued_at = None
            workflow.serial_queue_started_at = None
            workflow.serial_queue_completed_at = None
        if len(task_ids) < _METADATA_BATCH_SIZE:
            return


async def start_serial_queue(
    db: AsyncSession,
    project_id: str,
    task_ids: list[str],
) -> SerialQueueResult:
    lock = _PROJECT_LOCKS.setdefault(project_id, asyncio.Lock())
    async with lock:
        return await _start_serial_queue_locked(db, project_id, task_ids)


async def _start_serial_queue_locked(
    db: AsyncSession,
    project_id: str,
    task_ids: list[str],
) -> SerialQueueResult:
    project = await _project_or_error(db, project_id)
    if project.serial_queue_status in ACTIVE_PROJECT_QUEUE_STATUSES:
        raise SerialQueueError(
            "This project already has an active serial queue. Cancel it before "
            "starting another.",
            409,
        )
    if project.is_inbox or not project.path:
        raise SerialQueueError(
            "Serial execution requires one linked project workspace.",
            409,
        )
    try:
        workspace_path = tmux_service.require_workspace_path(project.path)
    except (tmux_service.TmuxServiceError, OSError, RuntimeError) as error:
        detail = getattr(error, "detail", None) or str(error) or (
            "The project workspace is not available."
        )
        status_code = getattr(error, "status_code", 409)
        raise SerialQueueError(detail, status_code) from error

    if not task_ids:
        raise SerialQueueError("Choose at least one Todo task.", 422)
    if len(task_ids) > MAX_SERIAL_QUEUE_TASKS:
        raise SerialQueueError(
            f"A serial queue can contain at most {MAX_SERIAL_QUEUE_TASKS} tasks.",
            422,
        )
    if len(set(task_ids)) != len(task_ids):
        raise SerialQueueError("A task can appear only once in a serial queue.", 422)

    result = await db.execute(
        select(Task)
        .options(selectinload(Task.workflow), selectinload(Task.quality_contract))
        .where(Task.id.in_(task_ids))
    )
    task_by_id = {task.id: task for task in result.scalars().all()}
    if len(task_by_id) != len(task_ids) or any(
        task_by_id[task_id].project_id != project.id
        for task_id in task_ids
        if task_id in task_by_id
    ):
        raise SerialQueueError(
            "Every queued task must exist in the same project.",
            422,
        )
    tasks = [task_by_id[task_id] for task_id in task_ids]
    if any(task.is_done or _workflow_state(task) != "todo" for task in tasks):
        raise SerialQueueError(
            "Only open Todo tasks can enter a serial execution queue.",
            409,
        )
    if any(
        task.workflow is not None
        and (
            task.workflow.research_status != "idle"
            or task.workflow.session_name is not None
            or task.workflow.prompt_sent_at is not None
        )
        for task in tasks
    ):
        raise SerialQueueError(
            "Tasks already dispatched to a research session cannot enter a "
            "serial execution queue.",
            409,
        )

    queue_id = uuid.uuid4().hex
    session_name = make_serial_queue_session_name(project.name, queue_id)
    queued_at = _now()
    await _clear_previous_queue_metadata(db, project.id)
    workflows: list[TaskWorkflow] = []
    for position, task in enumerate(tasks):
        workflow = await _workflow_for(db, task)
        workflow.serial_queue_id = queue_id
        workflow.serial_queue_position = position
        workflow.serial_queue_status = "running" if position == 0 else "queued"
        workflow.serial_queue_error = None
        workflow.serial_queue_enqueued_at = queued_at
        workflow.serial_queue_started_at = queued_at if position == 0 else None
        workflow.serial_queue_completed_at = None
        if position == 0:
            workflow.state = "in_progress"
            workflow.updated_at = queued_at
            task.updated_at = queued_at
        workflows.append(workflow)

    project.serial_queue_id = queue_id
    project.serial_queue_status = "running"
    project.serial_queue_session_name = session_name
    project.serial_queue_error = None
    project.serial_queue_created_at = queued_at
    project.serial_queue_updated_at = queued_at
    await db.commit()

    prompt = build_serial_queue_prompt(
        queue_id=queue_id,
        project_id=project.id,
        project_name=project.name,
        workspace_path=str(workspace_path),
        tasks=[
            SerialQueueTask(
                id=task.id,
                title=task.title,
                description=task.description or "",
                execution_prompt=(
                    task.execution_prompt or task.description or task.title
                ),
                origin=task.origin,
                quality_governed=task.quality_contract is not None,
            )
            for task in tasks
        ],
    )
    try:
        await tmux_service.create_session(
            workspace_path,
            project.name,
            session_name,
            mode="shell",
        )
        await tmux_service.start_codex(
            workspace_path,
            session_name,
            initial_prompt=prompt,
        )
    except (tmux_service.TmuxServiceError, OSError, RuntimeError) as error:
        detail = getattr(error, "detail", None) or str(error) or (
            "Dolphin could not start the serial queue session."
        )
        status_code = getattr(error, "status_code", 503)
        project.serial_queue_status = "paused"
        project.serial_queue_error = detail
        project.serial_queue_updated_at = _now()
        workflows[0].serial_queue_status = "failed"
        workflows[0].serial_queue_error = detail
        workflows[0].state = "todo"
        await db.commit()
        raise SerialQueueError(detail, status_code) from error

    return await get_serial_queue(db, project.id)


async def cancel_serial_queue(
    db: AsyncSession,
    project_id: str,
) -> SerialQueueResult:
    return await _cancel_serial_queue_locked(db, project_id)


async def _cancel_serial_queue_locked(
    db: AsyncSession,
    project_id: str,
) -> SerialQueueResult:
    lock = _PROJECT_LOCKS.setdefault(project_id, asyncio.Lock())
    async with lock:
        project = await _project_or_error(db, project_id)
        if (
            not project.serial_queue_id
            or project.serial_queue_status not in ACTIVE_PROJECT_QUEUE_STATUSES
        ):
            raise SerialQueueError(
                "This project does not have an active serial queue.",
                409,
            )

        now = _now()
        result = await db.execute(
            select(Task, TaskWorkflow)
            .join(Task, Task.id == TaskWorkflow.task_id)
            .where(
                Task.project_id == project.id,
                TaskWorkflow.serial_queue_id == project.serial_queue_id,
            )
        )
        queue_rows = list(result.all())
        for _task, workflow in queue_rows:
            if workflow.serial_queue_status != "completed":
                workflow.serial_queue_status = "cancelled"
                workflow.serial_queue_error = None
                workflow.serial_queue_completed_at = now
        project.serial_queue_status = "cancelled"
        project.serial_queue_error = None
        project.serial_queue_updated_at = now
        await db.commit()
        return await get_serial_queue(db, project.id)


async def advance_serial_queue_for_done_task(
    db: AsyncSession,
    task: Task,
    workflow: TaskWorkflow,
) -> None:
    """Advance a queue from the durable Done transition, never terminal output."""

    queue_id = workflow.serial_queue_id
    prior_status = workflow.serial_queue_status
    if not queue_id or prior_status == "not_queued":
        return

    now = _now()
    workflow.serial_queue_status = "completed"
    workflow.serial_queue_error = None
    workflow.serial_queue_completed_at = now

    project = await db.get(Project, task.project_id)
    if (
        project is None
        or project.serial_queue_id != queue_id
        or project.serial_queue_status != "running"
        or prior_status != "running"
    ):
        return

    result = await db.execute(
        select(Task, TaskWorkflow)
        .join(TaskWorkflow, TaskWorkflow.task_id == Task.id)
        .where(
            Task.project_id == project.id,
            TaskWorkflow.serial_queue_id == queue_id,
        )
        .order_by(TaskWorkflow.serial_queue_position, Task.id)
    )
    next_task: Task | None = None
    next_workflow: TaskWorkflow | None = None
    for candidate_task, candidate_workflow in result.all():
        if candidate_workflow.task_id == workflow.task_id:
            continue
        if (
            candidate_workflow.serial_queue_status == "queued"
            and candidate_task.is_done
        ):
            candidate_workflow.serial_queue_status = "completed"
            candidate_workflow.serial_queue_completed_at = (
                candidate_task.completed_at or now
            )
            continue
        if (
            next_workflow is None
            and candidate_workflow.serial_queue_status == "queued"
        ):
            next_task = candidate_task
            next_workflow = candidate_workflow

    completed_quality_contract = await db.get(TaskQualityContract, task.id)
    if next_workflow is None:
        project.serial_queue_status = "completed"
        project.serial_queue_error = None
    elif completed_quality_contract is not None:
        project.serial_queue_status = "paused"
        project.serial_queue_error = (
            "Independent Quality acceptance completed the current Todo. "
            "Cancel this paused queue, then explicitly start the remaining Todos "
            "as a new queue to continue."
        )
    else:
        next_workflow.serial_queue_status = "running"
        next_workflow.serial_queue_started_at = now
        next_workflow.serial_queue_error = None
        next_workflow.state = "in_progress"
        next_workflow.updated_at = now
        if next_task is not None:
            next_task.updated_at = now
    project.serial_queue_updated_at = now
