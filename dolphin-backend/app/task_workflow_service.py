"""Durable research-first Kanban workflow for Dolphin tasks."""

from __future__ import annotations

import asyncio
import json
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from . import receipts, run_service, tmux_service
from .models import (
    Project,
    Task,
    TaskQualityContract,
    TaskQualityEvent,
    TaskWorkflow,
)


WORKFLOW_STATES = frozenset({"todo", "in_progress", "review", "done"})
RESEARCH_STATUSES = frozenset(
    {"idle", "launching", "researching", "ready", "failed"}
)
_LAUNCH_LOCKS: dict[str, asyncio.Lock] = {}
_MANAGED_TEMP_PROJECT_LOCK = asyncio.Lock()
MANAGED_TEMP_PROJECT_ID = "dolphin-managed-temporary-workspaces"
MANAGED_TEMP_PROJECT_NAME = "Temporary workspace"
MANAGED_TEMP_ROOT_NAME = ".dolphin-task-workspaces"
PLACEMENT_KINDS = frozenset(
    {"explicit_project", "matched_project", "temporary"}
)
CLEANUP_STATUSES = frozenset(
    {
        "not_applicable",
        "active",
        "waiting_for_done",
        "waiting_for_session",
        "archived",
        "failed",
    }
)
_PLACEMENT_STOP_WORDS = frozenset(
    {
        "about",
        "above",
        "after",
        "again",
        "also",
        "and",
        "best",
        "build",
        "can",
        "change",
        "create",
        "do",
        "for",
        "from",
        "have",
        "highest",
        "implement",
        "into",
        "make",
        "new",
        "other",
        "our",
        "please",
        "project",
        "should",
        "task",
        "that",
        "the",
        "this",
        "todo",
        "use",
        "want",
        "with",
        "work",
    }
)
_PROJECT_SIGNAL_FILES = (
    "AGENTS.md",
    "README.md",
    "README.rst",
    "README.txt",
    ".planning/PROJECT.md",
    "pyproject.toml",
    "package.json",
    "Cargo.toml",
    ".git/config",
)


class TaskResearchLaunchError(Exception):
    """A user-visible launch error whose recovery state has already been saved."""

    def __init__(self, detail: str, status_code: int = 409):
        super().__init__(detail)
        self.detail = detail
        self.status_code = status_code


@dataclass(frozen=True)
class TaskResearchLaunchResult:
    task_id: str
    workflow_state: str
    research_status: str
    session_name: str
    reused: bool
    project_id: str
    project_name: str
    placement_kind: str
    workspace_path: str
    placement_reason: str
    placement_confidence: int
    cleanup_status: str


@dataclass(frozen=True)
class TaskResearchInputResult:
    task_id: str
    session_name: str
    status: str = "sent"


@dataclass(frozen=True)
class _PlacementCandidate:
    project: Project
    workspace_path: Path
    display_name: str
    score: int
    identity_matches: tuple[str, ...]
    context_matches: tuple[str, ...]


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.strip().lower()).strip("-")
    return slug or "task"


def _placement_tokens(value: str) -> set[str]:
    return {
        token
        for token in re.findall(r"[a-z0-9]+", value.lower())
        if len(token) >= 3 and token not in _PLACEMENT_STOP_WORDS
    }


def _workspace_signal_text(project: Project, workspace_path: Path) -> str:
    parts = [
        project.name,
        workspace_path.name,
        " ".join(workspace_path.parts[-3:]),
    ]
    try:
        parts.extend(
            child.name
            for child in sorted(workspace_path.iterdir(), key=lambda item: item.name)[
                :80
            ]
        )
    except OSError:
        pass
    remaining = 36_000
    for relative in _PROJECT_SIGNAL_FILES:
        if remaining <= 0:
            break
        candidate = workspace_path / relative
        try:
            if not candidate.is_file():
                continue
            chunk = candidate.read_text(errors="ignore")[: min(12_000, remaining)]
        except OSError:
            continue
        parts.append(chunk)
        remaining -= len(chunk)
    return "\n".join(parts)


def _score_candidate(
    project: Project,
    workspace_path: Path,
    task_text: str,
    task_tokens: set[str],
    signal_text: str,
) -> _PlacementCandidate:
    identity_tokens = _placement_tokens(
        f"{project.name} {workspace_path.name} {' '.join(workspace_path.parts[-2:])}"
    )
    signal_tokens = _placement_tokens(signal_text)
    identity_matches = sorted(task_tokens & identity_tokens)
    context_matches = sorted((task_tokens & signal_tokens) - set(identity_matches))
    score = len(identity_matches) * 10 + len(context_matches) * 3
    normalized_name = " ".join(project.name.lower().split())
    if (
        not project.is_inbox
        and len(normalized_name) >= 4
        and normalized_name in task_text.lower()
    ):
        score += 20
    display_name = (
        workspace_path.name.replace("-", " ").replace("_", " ").title()
        if project.is_inbox
        else project.name
    )
    return _PlacementCandidate(
        project=project,
        workspace_path=workspace_path,
        display_name=display_name,
        score=score,
        identity_matches=tuple(identity_matches),
        context_matches=tuple(context_matches),
    )


def _managed_workspace_root() -> Path:
    roots = tmux_service.workspace_roots()
    if not roots:
        raise tmux_service.TmuxServiceError(
            "No allowed workspace root is configured for temporary tasks.",
            409,
        )
    root = roots[0].expanduser().resolve()
    if not root.is_dir():
        raise tmux_service.TmuxServiceError(
            "The allowed workspace root for temporary tasks is unavailable.",
            409,
        )
    return root / MANAGED_TEMP_ROOT_NAME


def _provision_workspace_files(
    workspace_path: Path,
    *,
    task_id: str,
    title: str,
    description: str,
) -> None:
    workspace_path.mkdir(parents=True, exist_ok=True)
    agents_path = workspace_path / "AGENTS.md"
    task_path = workspace_path / "TASK.md"
    if not agents_path.exists():
        agents_path.write_text(
            "# Dolphin-managed temporary workspace\n\n"
            "This directory is isolated and owned by one Dolphin task. "
            "Research first. Do not implement, edit external projects, deploy, "
            "or take external action until the user explicitly approves the plan. "
            "Keep all task-created files inside this directory.\n"
        )
    if not task_path.exists():
        task_path.write_text(
            f"# {title}\n\n"
            f"Task ID: `{task_id}`\n\n"
            f"{description.strip() or 'No additional description was provided.'}\n"
        )


async def _managed_temp_project(
    db: AsyncSession,
    managed_root: Path,
) -> Project:
    project = await db.get(Project, MANAGED_TEMP_PROJECT_ID)
    if project is not None:
        configured = Path(project.path or "").expanduser().resolve()
        if configured != managed_root:
            raise tmux_service.TmuxServiceError(
                "The managed temporary-workspace project has an unexpected path.",
                409,
            )
        return project

    position = (
        await db.scalar(select(func.max(Project.position)))
    ) or 0
    project = Project(
        id=MANAGED_TEMP_PROJECT_ID,
        name=MANAGED_TEMP_PROJECT_NAME,
        emoji="🧰",
        color="#667085",
        path=str(managed_root),
        is_inbox=False,
        position=position + 1,
    )
    db.add(project)
    await db.flush()
    return project


def _remember_placement(
    workflow: TaskWorkflow,
    *,
    source_project_id: str,
    project_id: str,
    project_name: str,
    workspace_path: Path,
    kind: str,
    reason: str,
    confidence: int,
    cleanup_status: str,
) -> None:
    workflow.source_project_id = workflow.source_project_id or source_project_id
    workflow.placement_kind = kind
    workflow.placement_project_id = project_id
    workflow.placement_project_name = project_name
    workflow.placement_workspace_path = str(workspace_path)
    workflow.placement_reason = reason
    workflow.placement_confidence = confidence
    workflow.placement_generated_at = workflow.placement_generated_at or _now()
    workflow.cleanup_status = cleanup_status
    workflow.cleanup_error = None
    workflow.updated_at = _now()


async def _resolve_task_placement(
    db: AsyncSession,
    task: Task,
    workflow: TaskWorkflow,
) -> Path:
    if (
        workflow.placement_kind in PLACEMENT_KINDS
        and workflow.placement_workspace_path
        and workflow.placement_project_id
        and workflow.placement_project_name
    ):
        project = await db.get(Project, workflow.placement_project_id)
        if project is None:
            raise tmux_service.TmuxServiceError(
                "The task's selected execution project no longer exists.",
                404,
            )
        task.project_id = project.id
        task.project = project
        return tmux_service.require_workspace_path(
            workflow.placement_workspace_path
        )

    source_project_id = task.project_id
    if not task.project.is_inbox:
        workspace_path = tmux_service.require_workspace_path(task.project.path)
        _remember_placement(
            workflow,
            source_project_id=source_project_id,
            project_id=task.project.id,
            project_name=task.project.name,
            workspace_path=workspace_path,
            kind="explicit_project",
            reason=f"You selected {task.project.name} before research started.",
            confidence=100,
            cleanup_status="not_applicable",
        )
        return workspace_path

    task_text = f"{task.title}\n{task.description or ''}".strip()
    task_tokens = _placement_tokens(task_text)
    result = await db.execute(
        select(Project).order_by(Project.position, Project.created_at, Project.id)
    )
    candidates: list[_PlacementCandidate] = []
    for project in result.scalars().all():
        if project.id == MANAGED_TEMP_PROJECT_ID or not project.path:
            continue
        try:
            workspace_path = tmux_service.require_workspace_path(project.path)
        except tmux_service.TmuxServiceError:
            continue
        signal_text = await asyncio.to_thread(
            _workspace_signal_text,
            project,
            workspace_path,
        )
        candidates.append(
            _score_candidate(
                project,
                workspace_path,
                task_text,
                task_tokens,
                signal_text,
            )
        )

    candidates.sort(
        key=lambda candidate: (
            -candidate.score,
            candidate.project.position,
            candidate.project.id,
        )
    )
    best = candidates[0] if candidates else None
    runner_up_score = candidates[1].score if len(candidates) > 1 else 0
    strong_identity = bool(best and best.identity_matches)
    sufficient_context = bool(best and len(best.context_matches) >= 3)
    safe_match = bool(
        best
        and best.score >= 8
        and (strong_identity or sufficient_context)
        and best.score - runner_up_score >= 4
    )

    if safe_match and best is not None:
        matched = list(best.identity_matches) + list(best.context_matches)
        evidence = ", ".join(f"“{token}”" for token in matched[:3])
        reason = (
            f"Matched {evidence} in {best.display_name}'s project identity "
            "and workspace context."
        )
        confidence = min(
            98,
            max(60, 54 + best.score * 2 + (best.score - runner_up_score)),
        )
        task.project_id = best.project.id
        task.project = best.project
        _remember_placement(
            workflow,
            source_project_id=source_project_id,
            project_id=best.project.id,
            project_name=best.display_name,
            workspace_path=best.workspace_path,
            kind="matched_project",
            reason=reason,
            confidence=confidence,
            cleanup_status="not_applicable",
        )
        return best.workspace_path

    async with _MANAGED_TEMP_PROJECT_LOCK:
        managed_root = _managed_workspace_root()
        active_root = managed_root / "active"
        workspace_path = (
            active_root
            / f"{_slugify(task.title)[:48].rstrip('-')}-{task.id[:8].lower()}"
        )
        await asyncio.to_thread(
            _provision_workspace_files,
            workspace_path,
            task_id=task.id,
            title=task.title,
            description=task.description or "",
        )
        project = await _managed_temp_project(db, managed_root)
        task.project_id = project.id
        task.project = project
        _remember_placement(
            workflow,
            source_project_id=source_project_id,
            project_id=project.id,
            project_name=MANAGED_TEMP_PROJECT_NAME,
            workspace_path=workspace_path.resolve(),
            kind="temporary",
            reason=(
                "No existing project was a safe match, so Dolphin created an "
                "isolated temporary workspace."
            ),
            confidence=100,
            cleanup_status="active",
        )
        # Make the singleton project visible before another task can provision
        # against it. The launch state and external tmux side effect still
        # happen only after this durable placement commit.
        await db.commit()
    return workspace_path.resolve()


def _launch_result(
    task: Task,
    workflow: TaskWorkflow,
    *,
    reused: bool,
) -> TaskResearchLaunchResult:
    return TaskResearchLaunchResult(
        task_id=task.id,
        workflow_state="in_progress",
        research_status=workflow.research_status,
        session_name=workflow.session_name or "",
        reused=reused,
        project_id=workflow.placement_project_id or task.project_id,
        project_name=workflow.placement_project_name or task.project.name,
        placement_kind=workflow.placement_kind or "explicit_project",
        workspace_path=workflow.placement_workspace_path or task.project.path or "",
        placement_reason=workflow.placement_reason or "",
        placement_confidence=workflow.placement_confidence or 0,
        cleanup_status=workflow.cleanup_status or "not_applicable",
    )


def make_task_session_name(
    *,
    project_name: str,
    task_title: str,
    task_id: str,
) -> str:
    """Return a stable, tmux-safe task session name.

    Project name is accepted for a descriptive API but deliberately omitted from
    the identity. Renaming or moving a project must not orphan the task's run.
    """

    del project_name
    identity = re.sub(r"[^a-zA-Z0-9]", "", task_id)[:8].lower() or "task"
    prefix = "dolphin-task-"
    suffix = f"-{identity}"
    title_budget = 80 - len(prefix) - len(suffix)
    title_slug = _slugify(task_title)[:title_budget].rstrip("-")
    return f"{prefix}{title_slug}{suffix}"


def build_task_research_prompt(
    *,
    task_id: str,
    project_name: str,
    workspace_path: str,
    title: str,
    description: str,
    receipt_path: str | None = None,
) -> str:
    """Build a one-line prompt suitable for pasting into the Codex TUI.

    `receipt_path`, when given, is the exact absolute path a tracked run's
    Stop hook gates on (spec §7). Without it in the prompt, turn 1 of every
    tracked run is guaranteed to end with no receipt on disk, so the receipt
    gate blocks and forces a re-prompt every single time -- an entirely
    avoidable round trip. It is omitted for untracked dispatches (no Run
    exists, so nothing is watching for a receipt and telling the agent to
    write one would be a lie).
    """

    callback = f"/api/tasks/{task_id}/research-brief"
    task_context = json.dumps(
        {
            "task_id": task_id,
            "project": project_name,
            "workspace": workspace_path,
            "title": title,
            "description": description,
        },
        ensure_ascii=True,
        separators=(",", ":"),
    )
    review_transition = '{"workflow_state":"review"}'
    sections = [
        "Dolphin task research-only assignment.",
        f"Task context: {task_context}.",
        "Do not implement, edit files, commit, deploy, send messages, or take any external action until the user gives explicit approval after reviewing your plan.",
        "First inspect every applicable AGENTS.md and project planning document, the current git state, relevant source, tests, dependencies, configuration, and nearby established patterns.",
        "Research all information needed to carry the task through completely; verify unstable technical claims against primary sources and clearly distinguish evidence, inference, and unknowns.",
        "Use that project evidence to infer the user's most likely intent. Even when the wording is incomplete, choose a single best estimate and the safest concrete proposed action; do not stop at ambiguity or make clarification the recommendation. State assumptions and confidence, and ask a blocking question only when every bounded interpretation would be unsafe or materially destructive.",
        "Begin the brief with exactly `Recommendation: ...` on one line using at most two sentences and 180 characters, then `Confidence: high|medium|low - ...` and `Why: ...`. The recommendation must say what the user most likely meant and what you suggest doing. Open questions must not replace the best estimate; put them at the end.",
        "Produce a concise but complete research brief covering requirements and success criteria, current behavior, recommended approach, credible alternatives, dependencies, security and data risks, affected files, ordered execution steps, verification and acceptance tests, rollback, open questions, and your final recommendation.",
        f"When the brief is ready, persist it with PUT http://127.0.0.1:8400{callback} using JSON {{\"research_brief\":\"...\"}} if that local API is reachable; also present the same brief in this session.",
        f"After explicit approval only, you may implement and verify the work; once implementation is genuinely ready for human review, you may PUT http://127.0.0.1:8400/api/tasks/{task_id} with {review_transition}.",
        "Never mark the task done yourself; wait for the user to review and complete it.",
    ]
    if receipt_path is not None:
        sections.append(
            "This run is not finished until its receipt exists: before you "
            f"stop, write a short markdown summary to {receipt_path} "
            "covering what changed, which files, how to verify it, and "
            "anything left unfinished."
        )
    return " ".join(part.replace("\n", " ").strip() for part in sections)


def workflow_state_for(task: Task) -> str:
    workflow = task.__dict__.get("workflow")
    if workflow is not None and workflow.state in WORKFLOW_STATES:
        return workflow.state
    return "done" if task.is_done else "todo"


async def get_or_create_workflow(
    db: AsyncSession,
    task: Task,
) -> TaskWorkflow:
    loaded_workflow = task.__dict__.get("workflow")
    if loaded_workflow is not None:
        return loaded_workflow

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

async def _close_task_session(
    db: AsyncSession,
    task: Task,
    workflow: TaskWorkflow,
) -> None:
    expected_session_name = make_task_session_name(
        project_name="",
        task_title=task.title,
        task_id=task.id,
    )
    if workflow.session_name != expected_session_name:
        return
    workspace_raw = workflow.placement_workspace_path
    if not workspace_raw:
        project = task.__dict__.get("project")
        if project is None:
            project = await db.get(Project, task.project_id)
        workspace_raw = project.path if project is not None else None
    if not workspace_raw:
        return
    workspace_path = tmux_service.require_workspace_path(workspace_raw)
    try:
        await tmux_service.kill_session(workspace_path, workflow.session_name)
    except tmux_service.TmuxServiceError as error:
        if error.status_code != 404:
            raise


def _reset_research_run(workflow: TaskWorkflow) -> None:
    workflow.prompt_sent_at = None
    workflow.started_at = None
    workflow.research_completed_at = None
    workflow.research_status = "idle"
    workflow.research_brief = ""
    workflow.launch_error = None


async def set_task_workflow_state(
    db: AsyncSession,
    task: Task,
    state: str,
) -> TaskWorkflow:
    if state not in WORKFLOW_STATES:
        raise ValueError(f"Unsupported workflow state: {state}")

    if state == "done":
        # Imported locally to keep the workflow and quality services acyclic at
        # module load time. This is the common authority boundary used by API,
        # research, and serial-queue completion paths.
        from .quality_service import require_completion_authorized

        await require_completion_authorized(db, task.id)

    workflow = await get_or_create_workflow(db, task)
    if state == "done" and workflow.state != "done":
        await _close_task_session(db, task, workflow)
    now = _now()
    workflow.state = state
    workflow.updated_at = now
    task.is_done = state == "done"
    task.completed_at = now if state == "done" else None
    task.updated_at = now
    if state == "done":
        from .serial_queue_service import advance_serial_queue_for_done_task

        await advance_serial_queue_for_done_task(db, task, workflow)
    return workflow


async def _load_task(db: AsyncSession, task_id: str) -> Task:
    result = await db.execute(
        select(Task)
        .options(selectinload(Task.project), selectinload(Task.workflow))
        .where(Task.id == task_id)
    )
    task = result.scalar_one_or_none()
    if task is None:
        raise TaskResearchLaunchError("Task not found.", 404)
    return task


async def _refuse_retry_while_an_agent_is_alive(
    workspace_path: Path,
    session_name: str,
) -> None:
    """Refuse a retry that would dispatch into a session already holding an agent.

    `DOLPHIN_RUN_ID` can only enter an agent's environment at launch, so a
    *tracked* retry into a live agent is impossible. That is a real
    constraint, not a bug to code around, and the honest response is to say
    what was observed and what to do about it.

    This runs before `workflow.state`, `research_status` or
    `set_task_workflow_state` are touched and before any commit, because an
    action that reports failure must not have moved the board on its way out.

    Killing or interrupting the agent instead is deliberately out of scope:
    destroying a running agent is a destructive act that needs explicit
    operator authority.

    A probe that could not be completed is also a refusal. "No agent is
    running here" is precisely the assertion a failed probe cannot make, and
    the control plane may not assert what it has not observed. That covers
    both a tmux error and `observation_degraded`, which is the quieter of the
    two: when the pane probe fails, `_build_session_info` sets that flag and
    leaves both agent flags `False` **by construction**, so a session nobody
    could look into is indistinguishable from an empty one unless the flag is
    read. `tmux_service._require_observable_codex_session` already refuses on
    the same signal.
    """
    try:
        session = await tmux_service.require_workspace_session(
            workspace_path,
            session_name,
        )
    except tmux_service.TmuxServiceError as error:
        if error.status_code == 404:
            # No session at all, so nothing is running in one. The dispatch
            # path below creates it.
            return
        raise TaskResearchLaunchError(
            error.detail
            or str(error)
            or "Dolphin could not read that tmux session. Check tmux, then retry.",
            error.status_code,
        ) from error

    if session.observation_degraded:
        # Deliberately NOT folded into the message below: nothing observed an
        # agent here, and saying one is running would be the same invented
        # certainty, just pointed the other way.
        raise TaskResearchLaunchError(
            "Dolphin could not inspect that tmux session, so it cannot tell "
            "whether an agent is running in it. Open the session to check, "
            "then retry.",
            409,
        )

    if session.is_claude_code_running or session.is_codex_running:
        raise TaskResearchLaunchError(
            "An agent is still running in this session. Open the session and "
            "exit it, then retry.",
            409,
        )


async def launch_task_research(
    db: AsyncSession,
    task_id: str,
    *,
    retry: bool = False,
) -> TaskResearchLaunchResult:
    """Create/reuse one task-owned Codex session and send its prompt once.

    `retry=True` is the review queue's Retry action. It skips the
    "prompt already sent" early return, which every retryable run trips by
    construction — `prompt_sent_at` is written after each successful dispatch
    and only cleared when the session is found gone, while a run whose
    session died is swept to `abandoned` and leaves the queue. Without the
    flag, Retry reused the session, committed the card into In Progress, and
    dispatched nothing.
    """

    lock = _LAUNCH_LOCKS.setdefault(task_id, asyncio.Lock())
    async with lock:
        return await _launch_task_research_locked(db, task_id, retry=retry)


async def _launch_task_research_locked(
    db: AsyncSession,
    task_id: str,
    *,
    retry: bool = False,
) -> TaskResearchLaunchResult:
    task = await _load_task(db, task_id)
    if task.is_done:
        raise TaskResearchLaunchError(
            "Completed tasks must be reopened before starting research.",
            409,
        )
    if task.project is None:
        raise TaskResearchLaunchError("The task's project no longer exists.", 404)

    workflow = await get_or_create_workflow(db, task)
    if not workflow.session_name:
        workflow.session_name = make_task_session_name(
            project_name=task.project.name,
            task_title=task.title,
            task_id=task.id,
        )

    try:
        workspace_path = await _resolve_task_placement(db, task, workflow)
    except (tmux_service.TmuxServiceError, OSError, RuntimeError) as error:
        detail = getattr(error, "detail", None) or str(error) or (
            "Dolphin could not find or create a safe workspace for this task."
        )
        status_code = getattr(error, "status_code", 503)
        workflow.state = "todo"
        workflow.research_status = "failed"
        workflow.launch_error = detail
        workflow.updated_at = _now()
        await db.commit()
        raise TaskResearchLaunchError(detail, status_code) from error

    if retry:
        # Before any mutation, and before the early return below is skipped:
        # a retry that cannot be tracked must be refused, not attempted.
        await _refuse_retry_while_an_agent_is_alive(
            workspace_path,
            workflow.session_name,
        )

    if workflow.prompt_sent_at is not None and not retry:
        try:
            await tmux_service.require_workspace_session(
                workspace_path,
                workflow.session_name,
            )
        except tmux_service.TmuxServiceError as error:
            if error.status_code != 404:
                detail = error.detail or str(error) or "Research launch failed."
                workflow.state = "todo"
                workflow.research_status = "failed"
                workflow.launch_error = detail
                workflow.updated_at = _now()
                task.updated_at = _now()
                await db.commit()
                raise TaskResearchLaunchError(
                    detail,
                    error.status_code,
                ) from error
            _reset_research_run(workflow)
        else:
            await set_task_workflow_state(db, task, "in_progress")
            await db.commit()
            return _launch_result(task, workflow, reused=True)

    workflow.state = "in_progress"
    workflow.research_status = "launching"
    workflow.launch_error = None
    workflow.started_at = workflow.started_at or _now()
    workflow.updated_at = _now()
    task.is_done = False
    task.completed_at = None
    task.updated_at = _now()
    await db.commit()

    reused = True
    run = None  # bound before `try` so the except clause can always see it
    try:
        try:
            session = await tmux_service.require_workspace_session(
                workspace_path,
                workflow.session_name,
            )
        except tmux_service.TmuxServiceError as error:
            if error.status_code != 404:
                raise
            reused = False
            session = await tmux_service.create_session(
                workspace_path,
                workflow.placement_project_name or task.project.name,
                workflow.session_name,
                mode="shell",
            )

        prompt = build_task_research_prompt(
            task_id=task.id,
            project_name=workflow.placement_project_name or task.project.name,
            workspace_path=str(workspace_path),
            title=task.title,
            description=task.description or "",
        )
        no_agent_running = not getattr(
            session, "is_codex_running", True
        ) and not getattr(session, "is_claude_code_running", False)
        if no_agent_running:
            # DOLPHIN_RUN_ID can only enter an agent's environment at launch.
            # If Claude Code is already running here (e.g. the operator typed
            # `claude` by hand before this task's first launch), that process
            # is fundamentally untrackable -- creating a Run for it would be
            # exactly the dishonest bookkeeping this feature removes. Falling
            # through to the `else` branch below makes that case fail loudly
            # via send_input's require_codex guard instead.
            receipts.prepare_workspace(str(workspace_path))
            run = await run_service.create_run(
                db,
                task_id=task.id,
                project_id=workflow.placement_project_id or task.project_id,
                session_name=workflow.session_name,
                agent="claude",
                workspace_path=str(workspace_path),
            )
            # Rebuilt with the receipt instruction now that a run id exists
            # (spec §7): the untracked prompt above can't name a path for a
            # run that doesn't exist yet, and nothing observes a receipt for
            # the untracked (`else`) branch below at all.
            tracked_prompt = build_task_research_prompt(
                task_id=task.id,
                project_name=workflow.placement_project_name or task.project.name,
                workspace_path=str(workspace_path),
                title=task.title,
                description=task.description or "",
                receipt_path=str(
                    receipts.receipt_path(str(workspace_path), run.id)
                ),
            )
            await tmux_service.start_claude(
                workspace_path,
                workflow.session_name,
                initial_prompt=tracked_prompt,
                run_id=run.id,
            )
        else:
            await tmux_service.send_input(
                workspace_path,
                workflow.session_name,
                prompt,
                enter=True,
                require_codex=True,
            )
    except (tmux_service.TmuxServiceError, OSError, RuntimeError) as error:
        detail = getattr(error, "detail", None) or str(error) or "Research launch failed."
        status_code = getattr(error, "status_code", 503)
        if run is not None:
            # The row was written before the dispatch that was supposed to
            # follow it raised (spec §4, "-> failed | Dispatch raised").
            # Without this it sits at `dispatched` forever: the tmux session
            # it was sent to still exists, so reconciliation never abandons
            # it either -- a permanent phantom run (CRITICAL 1).
            await run_service.transition(db, run, "failed", error=detail)
        workflow.state = "todo"
        workflow.research_status = "failed"
        workflow.launch_error = detail
        workflow.updated_at = _now()
        task.updated_at = _now()
        await db.commit()
        raise TaskResearchLaunchError(detail, status_code) from error

    workflow.prompt_sent_at = _now()
    workflow.research_status = "researching"
    workflow.launch_error = None
    workflow.updated_at = _now()
    await db.commit()
    return _launch_result(task, workflow, reused=reused)


async def submit_research_brief(
    db: AsyncSession,
    task_id: str,
    research_brief: str,
) -> TaskWorkflow:
    task = await _load_task(db, task_id)
    workflow = await get_or_create_workflow(db, task)
    workflow.research_brief = research_brief.strip()
    workflow.research_status = "ready"
    workflow.research_completed_at = _now()
    workflow.launch_error = None
    workflow.updated_at = _now()
    await db.commit()
    return workflow


async def send_task_research_input(
    db: AsyncSession,
    task_id: str,
    text: str,
) -> TaskResearchInputResult:
    """Send one explicit follow-up to a task's verified, exact Codex session."""

    if not text.strip():
        raise TaskResearchLaunchError(
            "The Codex message cannot be empty.",
            422,
        )

    task = await _load_task(db, task_id)
    workflow = task.__dict__.get("workflow")
    if workflow is None:
        raise TaskResearchLaunchError(
            "This task does not have a research workflow yet.",
            409,
        )
    if task.is_done or workflow.state == "done":
        raise TaskResearchLaunchError(
            "Completed tasks must be reopened before sending input to Codex.",
            409,
        )
    if (
        workflow.research_status != "ready"
        or not workflow.research_brief.strip()
    ):
        raise TaskResearchLaunchError(
            "Continue in Codex is available after the research plan is ready.",
            409,
        )
    if not workflow.session_name:
        raise TaskResearchLaunchError(
            "No linked Codex session is recorded for this task.",
            409,
        )
    if not workflow.placement_workspace_path:
        raise TaskResearchLaunchError(
            "No linked workspace is recorded for this task.",
            409,
        )

    try:
        workspace_path = tmux_service.require_workspace_path(
            workflow.placement_workspace_path
        )
        await tmux_service.send_input(
            workspace_path,
            workflow.session_name,
            text,
            enter=True,
            require_codex=True,
        )
    except (tmux_service.TmuxServiceError, OSError, RuntimeError) as error:
        detail = getattr(error, "detail", None) or str(error) or (
            "Dolphin could not send input to the linked Codex session."
        )
        status_code = getattr(error, "status_code", 503)
        raise TaskResearchLaunchError(detail, status_code) from error

    return TaskResearchInputResult(
        task_id=task.id,
        session_name=workflow.session_name,
    )


def _path_is_within(path: Path, parent: Path) -> bool:
    return path == parent or parent in path.parents


async def archive_completed_temporary_workspace(
    db: AsyncSession,
    task_id: str,
    *,
    session_confirmed_closed: bool = False,
) -> TaskWorkflow:
    """Move an eligible Dolphin-owned workspace into a recoverable archive.

    User-owned project paths are never eligible. A live or unobservable exact
    task session fails closed and leaves the active directory untouched.
    """

    task = await _load_task(db, task_id)
    workflow = await get_or_create_workflow(db, task)
    if workflow.placement_kind != "temporary":
        workflow.cleanup_status = "not_applicable"
        workflow.cleanup_error = None
        await db.commit()
        return workflow
    if workflow.cleanup_status == "archived":
        return workflow
    if workflow.state != "done" or not task.is_done:
        workflow.cleanup_status = "waiting_for_done"
        workflow.cleanup_error = "Task is not done."
        await db.commit()
        return workflow
    if not workflow.placement_workspace_path:
        workflow.cleanup_status = "failed"
        workflow.cleanup_error = "The managed workspace path is missing."
        await db.commit()
        return workflow

    active_path = Path(workflow.placement_workspace_path).expanduser().resolve()
    managed_root = _managed_workspace_root().resolve()
    active_root = (managed_root / "active").resolve()
    archive_root = (managed_root / "archive").resolve()
    if not _path_is_within(active_path, active_root) or active_path == active_root:
        workflow.cleanup_status = "failed"
        workflow.cleanup_error = (
            "Dolphin refused cleanup because this is not a proven task-owned "
            "temporary workspace."
        )
        await db.commit()
        return workflow

    if workflow.session_name and not session_confirmed_closed:
        try:
            sessions = await tmux_service.list_all_sessions()
        except (tmux_service.TmuxServiceError, OSError, RuntimeError):
            workflow.cleanup_status = "waiting_for_session"
            workflow.cleanup_error = (
                "Session status is unavailable; the workspace was preserved."
            )
            await db.commit()
            return workflow
        if any(session.name == workflow.session_name for session in sessions):
            workflow.cleanup_status = "waiting_for_session"
            workflow.cleanup_error = (
                f"Session {workflow.session_name} is still open."
            )
            await db.commit()
            return workflow

    if not active_path.exists():
        archive_path = (
            Path(workflow.cleanup_archive_path).expanduser().resolve()
            if workflow.cleanup_archive_path
            else None
        )
        if archive_path and archive_path.is_dir() and _path_is_within(
            archive_path,
            archive_root,
        ):
            workflow.cleanup_status = "archived"
            workflow.cleanup_error = None
            workflow.cleanup_completed_at = (
                workflow.cleanup_completed_at or _now()
            )
        else:
            workflow.cleanup_status = "failed"
            workflow.cleanup_error = (
                "The active temporary workspace could not be found; no files "
                "were removed."
            )
        await db.commit()
        return workflow

    timestamp = _now().strftime("%Y%m%dT%H%M%SZ")
    archive_path = archive_root / f"{active_path.name}-{timestamp}"
    suffix = 1
    while archive_path.exists():
        archive_path = archive_root / f"{active_path.name}-{timestamp}-{suffix}"
        suffix += 1

    try:
        await asyncio.to_thread(archive_root.mkdir, parents=True, exist_ok=True)
        await asyncio.to_thread(active_path.rename, archive_path)
    except OSError as error:
        workflow.cleanup_status = "failed"
        workflow.cleanup_error = (
            f"Temporary workspace archival failed safely: {str(error)[:240]}"
        )
        await db.commit()
        return workflow

    workflow.cleanup_status = "archived"
    workflow.cleanup_archive_path = str(archive_path)
    workflow.cleanup_completed_at = _now()
    workflow.cleanup_error = None
    workflow.updated_at = _now()
    await db.commit()
    return workflow


async def archive_temporary_workspace_for_closed_session(
    db: AsyncSession,
    session_name: str,
) -> TaskWorkflow | None:
    workflow = await db.scalar(
        select(TaskWorkflow).where(TaskWorkflow.session_name == session_name)
    )
    if workflow is None or workflow.placement_kind != "temporary":
        return None
    return await archive_completed_temporary_workspace(
        db,
        workflow.task_id,
        session_confirmed_closed=True,
    )


async def reconcile_temporary_workspace_cleanup(
    db: AsyncSession,
) -> int:
    """Archive completed managed workspaces whose exact session has closed."""

    result = await db.execute(
        select(TaskWorkflow.task_id)
        .join(Task, Task.id == TaskWorkflow.task_id)
        .where(
            TaskWorkflow.placement_kind == "temporary",
            TaskWorkflow.cleanup_status.in_(
                {"active", "waiting_for_done", "waiting_for_session", "failed"}
            ),
            Task.is_done == True,
        )
    )
    reconciled = 0
    for task_id in result.scalars().all():
        workflow = await archive_completed_temporary_workspace(db, task_id)
        if workflow.cleanup_status == "archived":
            reconciled += 1
    return reconciled


async def restore_archived_temporary_workspace(
    db: AsyncSession,
    task_id: str,
) -> TaskWorkflow:
    task = await _load_task(db, task_id)
    workflow = await get_or_create_workflow(db, task)
    if (
        workflow.placement_kind != "temporary"
        or workflow.cleanup_status != "archived"
        or not workflow.cleanup_archive_path
        or not workflow.placement_workspace_path
    ):
        raise TaskResearchLaunchError(
            "This task does not have an archived Dolphin temporary workspace.",
            409,
        )

    managed_root = _managed_workspace_root().resolve()
    active_root = (managed_root / "active").resolve()
    archive_root = (managed_root / "archive").resolve()
    active_path = Path(workflow.placement_workspace_path).expanduser().resolve()
    archive_path = Path(workflow.cleanup_archive_path).expanduser().resolve()
    if (
        not _path_is_within(active_path, active_root)
        or active_path == active_root
        or not _path_is_within(archive_path, archive_root)
        or archive_path == archive_root
    ):
        raise TaskResearchLaunchError(
            "Dolphin refused restore because the recorded paths are not "
            "proven managed-workspace paths.",
            409,
        )
    if active_path.exists():
        raise TaskResearchLaunchError(
            "The active temporary-workspace path already exists.",
            409,
        )
    if not archive_path.is_dir():
        raise TaskResearchLaunchError(
            "The archived temporary workspace could not be found.",
            404,
        )

    try:
        await asyncio.to_thread(active_path.parent.mkdir, parents=True, exist_ok=True)
        await asyncio.to_thread(archive_path.rename, active_path)
    except OSError as error:
        raise TaskResearchLaunchError(
            f"Temporary workspace restore failed safely: {str(error)[:240]}",
            503,
        ) from error

    workflow.cleanup_status = "active"
    workflow.cleanup_error = None
    workflow.cleanup_archive_path = None
    workflow.cleanup_completed_at = None
    workflow.updated_at = _now()
    await db.commit()
    return workflow


async def set_owner_task_completion(db: AsyncSession, task: Task, done: bool) -> TaskWorkflow:
    """Explicit owner decision, not an evidence acceptance or agent completion.

    Leave live sessions alone. A checkbox changes
    the task record; it does not authorize killing a session or starting more work.
    """
    workflow = await get_or_create_workflow(db, task)
    state = 'done' if done else 'todo'
    if task.is_done == done and workflow.state == state:
        return workflow
    contract = await db.get(TaskQualityContract, task.id)
    db.add(TaskQualityEvent(
        project_id=task.project_id, task_id=task.id,
        contract_revision=contract.revision if contract else 0,
        kind='owner_completion' if done else 'owner_reopened', actor='human:owner',
        from_stage=workflow.state, to_stage=state,
        reason='Explicit manual task status change by the workspace owner; not an evidence review.',
    ))
    now = _now()
    task.is_done = done
    task.completed_at = now if done else None
    task.updated_at = now
    workflow.state = state
    workflow.updated_at = now
    return workflow
