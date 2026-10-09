"""Read-only aggregation for the global Dolphin control center."""

import asyncio
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import event, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session, selectinload

from . import run_service, tmux_service
from .models import Project, Run, Task
from .schemas import (
    ControlCenterLatestRunResponse,
    ControlCenterProjectResponse,
    ControlCenterResponse,
    ControlCenterSessionResponse,
    ControlCenterSourceResponse,
    ControlCenterTaskResponse,
    ControlCenterWorkspaceResponse,
)
from .task_workflow_service import MANAGED_TEMP_PROJECT_ID, workflow_state_for


_DURABLE_DECK_CACHE_TTL_SECONDS = 12.0
_DURABLE_DECK_CACHE: dict[str, tuple[float, ControlCenterResponse]] = {}


def _database_cache_key(bind) -> str | None:
    url = getattr(bind, "url", None)
    return str(url) if url is not None else None


def invalidate_durable_deck_cache(database_key: str | None = None) -> None:
    if database_key is None:
        _DURABLE_DECK_CACHE.clear()
        return
    _DURABLE_DECK_CACHE.pop(database_key, None)


@event.listens_for(Session, "after_commit")
def _invalidate_durable_deck_after_commit(session: Session) -> None:
    try:
        database_key = _database_cache_key(session.get_bind())
    except (AttributeError, RuntimeError):
        database_key = None
    invalidate_durable_deck_cache(database_key)


def _cached_durable_deck(db: AsyncSession) -> ControlCenterResponse | None:
    database_key = _database_cache_key(db.bind)
    if database_key is None:
        return None
    cached = _DURABLE_DECK_CACHE.get(database_key)
    if cached is None:
        return None
    cached_at, response = cached
    if (
        asyncio.get_running_loop().time() - cached_at
        >= _DURABLE_DECK_CACHE_TTL_SECONDS
    ):
        _DURABLE_DECK_CACHE.pop(database_key, None)
        return None
    return response.model_copy(deep=True)


def _durable_deck_projection(
    snapshot: ControlCenterResponse,
) -> ControlCenterResponse:
    projects = [
        project.model_copy(
            update={
                "session_count": 0,
                "codex_session_count": 0,
                "sessions": [],
            },
            deep=True,
        )
        for project in snapshot.projects
    ]
    return ControlCenterResponse(
        collected_at=snapshot.collected_at,
        status="degraded",
        tmux=ControlCenterSourceResponse(
            state="unavailable",
            message="Session details are loading. Tmux observation is deferred.",
        ),
        project_count=len(projects),
        open_task_count=sum(project.open_task_count for project in projects),
        unique_session_count=0,
        codex_session_count=0,
        needs_setup_count=snapshot.needs_setup_count,
        projects=projects,
    )


def _store_durable_deck(
    db: AsyncSession,
    snapshot: ControlCenterResponse,
) -> None:
    database_key = _database_cache_key(db.bind)
    if database_key is None:
        return
    _DURABLE_DECK_CACHE[database_key] = (
        asyncio.get_running_loop().time(),
        _durable_deck_projection(snapshot),
    )


@dataclass(frozen=True)
class _WorkspaceObservation:
    response: ControlCenterWorkspaceResponse
    ready_path: Path | None


@dataclass(frozen=True)
class _SessionObservation:
    response: ControlCenterSessionResponse
    paths: tuple[Path, ...]


def _workspace_observation(raw_path: str | None) -> _WorkspaceObservation:
    try:
        status = tmux_service.workspace_path_status(raw_path)
    except (OSError, RuntimeError, ValueError):
        return _WorkspaceObservation(
            response=ControlCenterWorkspaceResponse(
                state="unavailable",
                path=raw_path,
                message="Workspace status is temporarily unavailable.",
            ),
            ready_path=None,
        )

    if not raw_path:
        state = "unlinked"
    elif not status.path_exists:
        state = "missing"
    elif not status.is_directory:
        state = "not_directory"
    elif not status.is_allowed:
        state = "outside_root"
    else:
        state = "ready"

    ready_path = Path(status.path) if state == "ready" and status.path else None
    return _WorkspaceObservation(
        response=ControlCenterWorkspaceResponse(
            state=state,
            path=status.path,
            message=status.message,
        ),
        ready_path=ready_path,
    )


def _task_response(
    task: Task, latest_runs: dict[str, Run]
) -> ControlCenterTaskResponse:
    workflow = task.workflow
    research_brief = workflow.research_brief if workflow else ""
    excerpt = research_brief[:280].strip() if research_brief else None
    if excerpt and len(research_brief) > len(excerpt):
        excerpt = f"{excerpt.rstrip()}…"
    return ControlCenterTaskResponse(
        id=task.id,
        project_id=task.project_id,
        section_id=task.section_id,
        title=task.title,
        description=task.description or "",
        origin=task.origin,
        execution_prompt=(task.execution_prompt or task.description or task.title),
        priority=task.priority,
        due_date=task.due_date,
        due_time=task.due_time,
        is_done=task.is_done,
        position=task.position,
        created_at=task.created_at,
        updated_at=task.updated_at,
        completed_at=task.completed_at,
        workflow_state=workflow_state_for(task),
        research_status=workflow.research_status if workflow else "idle",
        research_session_name=workflow.session_name if workflow else None,
        research_error=workflow.launch_error if workflow else None,
        has_research_brief=bool(research_brief),
        research_brief_excerpt=excerpt,
        research_started_at=workflow.started_at if workflow else None,
        research_completed_at=(
            workflow.research_completed_at if workflow else None
        ),
        placement_kind=workflow.placement_kind if workflow else None,
        placement_project_id=(
            workflow.placement_project_id if workflow else None
        ),
        placement_project_name=(
            workflow.placement_project_name if workflow else None
        ),
        placement_workspace_path=(
            workflow.placement_workspace_path if workflow else None
        ),
        placement_reason=workflow.placement_reason if workflow else None,
        placement_confidence=(
            workflow.placement_confidence if workflow else None
        ),
        placement_generated_at=(
            workflow.placement_generated_at if workflow else None
        ),
        cleanup_status=(
            workflow.cleanup_status if workflow else "not_applicable"
        ),
        cleanup_error=workflow.cleanup_error if workflow else None,
        cleanup_archive_path=(
            workflow.cleanup_archive_path if workflow else None
        ),
        cleanup_completed_at=(
            workflow.cleanup_completed_at if workflow else None
        ),
        serial_queue_id=workflow.serial_queue_id if workflow else None,
        serial_queue_position=(
            workflow.serial_queue_position if workflow else None
        ),
        serial_queue_status=(
            workflow.serial_queue_status if workflow else "not_queued"
        ),
        serial_queue_error=(
            workflow.serial_queue_error if workflow else None
        ),
        serial_queue_enqueued_at=(
            workflow.serial_queue_enqueued_at if workflow else None
        ),
        serial_queue_started_at=(
            workflow.serial_queue_started_at if workflow else None
        ),
        serial_queue_completed_at=(
            workflow.serial_queue_completed_at if workflow else None
        ),
        latest_run=(
            ControlCenterLatestRunResponse(
                id=latest.id,
                state=latest.state,
                agent=latest.agent,
                turn_count=latest.turn_count,
                dispatched_at=latest.dispatched_at,
                has_receipt=latest.receipt_path is not None,
            )
            if (latest := latest_runs.get(task.id)) is not None
            else None
        ),
    )


def _resolved_path(raw_path: str | Path) -> Path:
    return Path(raw_path).expanduser().resolve()


async def _observe_session(
    session: tmux_service.TmuxSessionInfo,
) -> _SessionObservation:
    paths: list[Path] = []
    degraded = session.observation_degraded

    try:
        paths.append(_resolved_path(session.path))
    except (OSError, RuntimeError, ValueError):
        degraded = True

    if session.pane_paths is not None:
        pane_paths = session.pane_paths
    else:
        try:
            pane_paths = await tmux_service.pane_current_paths(
                session.name,
                strict=True,
            )
        except (
            OSError,
            RuntimeError,
            ValueError,
            tmux_service.TmuxServiceError,
        ):
            pane_paths = []
            degraded = True

    for pane_path in pane_paths:
        try:
            paths.append(_resolved_path(pane_path))
        except (OSError, RuntimeError, ValueError):
            degraded = True

    message = "Some session details could not be inspected." if degraded else None
    return _SessionObservation(
        response=ControlCenterSessionResponse(
            name=session.name,
            path=session.path,
            created_at=session.created_at,
            windows=session.windows,
            attached=session.attached,
            current_command=session.current_command,
            is_codex_running=session.is_codex_running,
            has_recent_activity=session.has_recent_activity,
            last_activity_at=session.last_activity_at,
            observation_state="degraded" if degraded else "available",
            observation_message=message,
        ),
        paths=tuple(paths),
    )


def _path_belongs_to_workspace(path: Path, workspace: Path) -> bool:
    return path == workspace or workspace in path.parents


async def build_control_center(
    db: AsyncSession,
    *,
    include_sessions: bool = True,
    reconcile_run_state: bool = True,
) -> ControlCenterResponse:
    """Build one stable snapshot from durable rows and optional tmux evidence.

    The task-first projection deliberately skips tmux discovery so durable work can
    paint immediately. The regular snapshot enriches the same project/task rows
    with observable session evidence. Existing callers reconcile durable run state
    from a successful inventory by default; observation-only callers can disable
    that reconciliation without disabling tmux observation.
    """
    if not include_sessions:
        cached_deck = _cached_durable_deck(db)
        if cached_deck is not None:
            return cached_deck

    result = await db.execute(
        select(Project)
        .options(selectinload(Project.tasks).selectinload(Task.workflow))
        .order_by(Project.position, Project.created_at, Project.id)
    )
    projects = list(result.scalars().all())

    workspace_by_project = {
        project.id: _workspace_observation(project.path) for project in projects
    }
    tasks_by_project = {
        project.id: sorted(
            project.tasks,
            key=lambda task: (
                task.is_done,
                task.position,
                task.created_at,
                task.id,
            ),
        )
        for project in projects
    }

    inventory_unavailable = False
    if not include_sessions:
        inventory = []
    else:
        try:
            inventory = await tmux_service.list_all_sessions()
        except (
            OSError,
            RuntimeError,
            ValueError,
            tmux_service.TmuxServiceError,
        ):
            inventory = []
            inventory_unavailable = True

    if include_sessions and not inventory_unavailable and reconcile_run_state:
        # This guard is load-bearing, not incidental: `inventory` is `[]` in
        # two cases that are NOT "no sessions exist" — `include_sessions` is
        # False (the task-first deck deliberately skips tmux discovery) and
        # `inventory_unavailable` is True (the tmux read raised). Calling
        # reconcile_runs with an empty set in either case would read as "every
        # session is gone" and abandon every open run system-wide on evidence
        # that was never gathered — the exact class of error this feature
        # exists to remove. So this only runs once `inventory` is a real,
        # freshly-read tmux inventory (possibly genuinely empty).
        #
        # This is also the promotion trigger named in spec §4 for
        # `dispatched -> running`: this inventory read is the process-tree
        # probe, and it is already in hand here, so wiring it costs no extra
        # tmux or database work. Observing a process alive is a fact, not the
        # completion inference this feature refuses to make -- only the
        # receipt gate closes a run.
        await run_service.reconcile_runs(
            db,
            {session.name for session in inventory},
            running_sessions_by_agent={
                "codex": {
                    session.name for session in inventory if session.is_codex_running
                },
                "claude": {
                    session.name
                    for session in inventory
                    if session.is_claude_code_running
                },
            },
        )

    # After reconciliation, deliberately: a run abandoned or promoted by the
    # sweep above must show its post-sweep state in the same snapshot, not the
    # state it held a moment earlier. Unconditional, so card badges paint with
    # the first durable deck rather than 10s later.
    latest_runs = await run_service.latest_runs_by_task(db)

    observations: list[_SessionObservation]
    if not include_sessions or inventory_unavailable:
        observations = []
    else:
        observations = list(
            await asyncio.gather(*(_observe_session(session) for session in inventory))
        )

    any_probe_degraded = any(
        observation.response.observation_state == "degraded"
        for observation in observations
    )
    if not include_sessions:
        tmux = ControlCenterSourceResponse(
            state="unavailable",
            message="Session details are loading. Tmux observation is deferred.",
        )
    elif inventory_unavailable:
        tmux = ControlCenterSourceResponse(
            state="unavailable",
            message="Session status is temporarily unavailable.",
        )
    elif any_probe_degraded:
        tmux = ControlCenterSourceResponse(
            state="degraded",
            message="Some session details could not be inspected.",
        )
    else:
        tmux = ControlCenterSourceResponse(state="available")

    sessions_by_project: dict[str, list[ControlCenterSessionResponse]] = {
        project.id: [] for project in projects
    }
    associated_session_names: set[str] = set()
    associated_codex_names: set[str] = set()

    for observation in observations:
        associated = False
        for project in projects:
            workspace_path = workspace_by_project[project.id].ready_path
            if workspace_path is None:
                continue
            if any(
                _path_belongs_to_workspace(path, workspace_path)
                for path in observation.paths
            ):
                sessions_by_project[project.id].append(observation.response)
                associated = True
        if associated:
            associated_session_names.add(observation.response.name)
            if observation.response.is_codex_running:
                associated_codex_names.add(observation.response.name)

    project_responses: list[ControlCenterProjectResponse] = []
    for project in projects:
        project_tasks = tasks_by_project[project.id]
        tasks = [_task_response(task, latest_runs) for task in project_tasks]
        sessions = sessions_by_project[project.id]
        project_responses.append(
            ControlCenterProjectResponse(
                id=project.id,
                name=project.name,
                emoji=project.emoji or "",
                color=project.color,
                path=project.path,
                is_inbox=project.is_inbox,
                is_temporary_workspace=(
                    project.id == MANAGED_TEMP_PROJECT_ID
                ),
                position=project.position,
                created_at=project.created_at,
                updated_at=project.updated_at,
                open_task_count=sum(not task.is_done for task in project_tasks),
                session_count=len(sessions),
                codex_session_count=sum(
                    session.is_codex_running for session in sessions
                ),
                serial_queue_id=project.serial_queue_id,
                serial_queue_status=project.serial_queue_status or "idle",
                serial_queue_session_name=project.serial_queue_session_name,
                serial_queue_error=project.serial_queue_error,
                serial_queue_created_at=project.serial_queue_created_at,
                serial_queue_updated_at=project.serial_queue_updated_at,
                workspace=workspace_by_project[project.id].response,
                tasks=tasks,
                sessions=sessions,
            )
        )

    needs_setup_count = sum(
        observation.response.state != "ready"
        for observation in workspace_by_project.values()
    )
    degraded = (
        tmux.state != "available"
        or needs_setup_count > 0
    )
    snapshot = ControlCenterResponse(
        collected_at=datetime.now(timezone.utc),
        status="degraded" if degraded else "ok",
        tmux=tmux,
        project_count=len(project_responses),
        open_task_count=sum(
            project.open_task_count for project in project_responses
        ),
        unique_session_count=len(associated_session_names),
        codex_session_count=len(associated_codex_names),
        needs_setup_count=needs_setup_count,
        projects=project_responses,
    )
    _store_durable_deck(db, snapshot)
    return snapshot
