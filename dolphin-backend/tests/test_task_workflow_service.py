import asyncio
import importlib
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

import pytest
from fastapi.routing import APIRoute
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.database import Base
from app.models import Project, Task
from app.tmux_service import TmuxServiceError, TmuxSessionInfo


def _load_service():
    return importlib.import_module("app.task_workflow_service")


@asynccontextmanager
async def _temporary_db(tmp_path: Path):
    engine = create_async_engine(
        f"sqlite+aiosqlite:///{tmp_path / 'task-workflow.db'}"
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


def _shell_session(name: str, path: Path) -> TmuxSessionInfo:
    return TmuxSessionInfo(
        name=name,
        path=str(path),
        created_at=datetime.now(timezone.utc),
        windows=1,
        attached=False,
        current_command="bash",
        is_codex_running=False,
    )


def _claude_session(name: str, path: Path) -> TmuxSessionInfo:
    return TmuxSessionInfo(
        name=name,
        path=str(path),
        created_at=datetime.now(timezone.utc),
        windows=1,
        attached=False,
        current_command="claude",
        is_codex_running=False,
        is_claude_code_running=True,
    )


async def _seed_task(db: AsyncSession, workspace: Path) -> Task:
    project = Project(
        id="project-1",
        name="Dolphin Tasks",
        path=str(workspace),
        color="#176B87",
        position=0,
    )
    task = Task(
        id="task-abcdef123456",
        project_id=project.id,
        title="Build the agent Kanban",
        description="Create a smooth research-first workflow.",
        priority=1,
        position=0,
    )
    db.add_all([project, task])
    await db.commit()
    return task


async def _ready_workflow(service, db: AsyncSession, task: Task, workspace: Path):
    workflow = await service.get_or_create_workflow(db, task)
    workflow.state = "in_progress"
    workflow.session_name = service.make_task_session_name(
        project_name="Dolphin Tasks",
        task_title=task.title,
        task_id=task.id,
    )
    workflow.research_status = "ready"
    workflow.research_brief = "Recommendation: use the exact linked session."
    workflow.research_completed_at = datetime.now(timezone.utc)
    workflow.placement_kind = "explicit_project"
    workflow.placement_project_id = task.project_id
    workflow.placement_project_name = "Dolphin Tasks"
    workflow.placement_workspace_path = str(workspace.resolve())
    workflow.placement_reason = "You selected Dolphin Tasks."
    workflow.placement_confidence = 100
    await db.commit()
    return workflow


def test_research_prompt_is_exhaustive_but_does_not_authorize_implementation():
    service = _load_service()

    prompt = service.build_task_research_prompt(
        task_id="task-1",
        project_name="Dolphin Tasks",
        workspace_path="/srv/dolphin-tasks",
        title="Build the agent Kanban",
        description="Research the complete implementation.",
    )

    assert "\n" not in prompt
    assert "research-only" in prompt.lower()
    assert "explicit approval" in prompt.lower()
    assert "do not implement" in prompt.lower()
    assert "AGENTS.md" in prompt
    assert "current git state" in prompt
    assert "primary sources" in prompt
    assert "single best estimate" in prompt
    assert "do not stop at ambiguity" in prompt.lower()
    assert "Recommendation:" in prompt
    assert "180 characters" in prompt
    assert "Confidence:" in prompt
    assert "open questions must not replace" in prompt.lower()
    assert "affected files" in prompt
    assert "verification" in prompt
    assert "rollback" in prompt
    assert "/api/tasks/task-1/research-brief" in prompt
    assert '"workflow_state":"review"' in prompt


def test_task_session_name_is_stable_valid_and_task_specific():
    service = _load_service()

    name = service.make_task_session_name(
        project_name="Dolphin Tasks",
        task_title="Build a delightful multi-project board!",
        task_id="abcdef1234567890",
    )

    assert name == "dolphin-task-build-a-delightful-multi-project-board-abcdef12"
    assert len(name) <= 80
    assert service.make_task_session_name(
        project_name="Other",
        task_title="Build a delightful multi-project board!",
        task_id="abcdef1234567890",
    ) == name


def test_task_research_session_input_route_is_typed_and_task_scoped():
    main = importlib.import_module("app.main")
    schemas = importlib.import_module("app.schemas")
    routes = [
        route
        for route in main.app.routes
        if isinstance(route, APIRoute)
        and route.path == "/api/tasks/{task_id}/research-session/input"
    ]

    assert len(routes) == 1
    route = routes[0]
    assert route.methods == {"POST"}
    assert route.response_model is schemas.TaskResearchSessionInputResponse


@pytest.mark.asyncio
async def test_first_in_progress_transition_launches_one_research_session(
    tmp_path,
    monkeypatch,
):
    service = _load_service()
    workspace = tmp_path / "projects" / "dolphin"
    workspace.mkdir(parents=True)
    monkeypatch.setenv("DOLPHIN_WORKSPACE_ROOTS", str(tmp_path / "projects"))

    created: list[tuple[Path, str, str | None, str]] = []
    sent: list[tuple[Path, str, str, bool, bool]] = []
    live_sessions: dict[str, TmuxSessionInfo] = {}

    async def fake_require(path: Path, name: str):
        if name not in live_sessions:
            raise TmuxServiceError("missing", 404)
        return live_sessions[name]

    async def fake_create(
        path: Path,
        project_name: str,
        requested_name: str | None = None,
        mode: str = "shell",
    ):
        created.append((path, project_name, requested_name, mode))
        assert requested_name is not None
        live_sessions[requested_name] = _session(requested_name, path)
        return live_sessions[requested_name]

    async def fake_send(
        path: Path,
        name: str,
        text: str,
        enter: bool = True,
        *,
        require_codex: bool = False,
    ):
        sent.append((path, name, text, enter, require_codex))

    monkeypatch.setattr(service.tmux_service, "require_workspace_session", fake_require)
    monkeypatch.setattr(service.tmux_service, "create_session", fake_create)
    monkeypatch.setattr(service.tmux_service, "send_input", fake_send)

    async with _temporary_db(tmp_path) as db:
        await _seed_task(db, workspace)

        result = await service.launch_task_research(db, "task-abcdef123456")

        assert result.workflow_state == "in_progress"
        assert result.research_status == "researching"
        assert result.session_name.startswith("dolphin-task-build-the-agent-kanban-")
        assert result.reused is False
        assert created == [
            (
                workspace.resolve(),
                "Dolphin Tasks",
                result.session_name,
                "shell",
            )
        ]
        assert len(sent) == 1
        assert sent[0][0] == workspace.resolve()
        assert sent[0][1] == result.session_name
        assert "research-only" in sent[0][2].lower()
        assert sent[0][3] is True
        assert sent[0][4] is True

        workflow = await db.scalar(
            select(service.TaskWorkflow).where(
                service.TaskWorkflow.task_id == "task-abcdef123456"
            )
        )
        assert workflow is not None
        assert workflow.prompt_sent_at is not None
        assert workflow.launch_error is None


@pytest.mark.asyncio
async def test_first_launch_bootstraps_shell_and_starts_claude_with_prompt(
    tmp_path,
    monkeypatch,
):
    service = _load_service()
    workspace = tmp_path / "projects" / "dolphin"
    workspace.mkdir(parents=True)
    monkeypatch.setenv("DOLPHIN_WORKSPACE_ROOTS", str(tmp_path / "projects"))
    events: list[tuple] = []
    live_sessions: dict[str, TmuxSessionInfo] = {}

    async def fake_require(path: Path, name: str):
        if name not in live_sessions:
            raise TmuxServiceError("missing", 404)
        return live_sessions[name]

    async def fake_create(
        path: Path,
        project_name: str,
        requested_name: str | None = None,
        mode: str = "shell",
    ):
        assert requested_name is not None
        events.append(("create", mode))
        live_sessions[requested_name] = _shell_session(requested_name, path)
        return live_sessions[requested_name]

    async def fake_start_claude(
        path: Path,
        name: str,
        initial_prompt: str | None = None,
        run_id: str | None = None,
    ):
        events.append(("start_claude", path, name, initial_prompt, run_id))

    async def unexpected_start_codex(*_args, **_kwargs):
        raise AssertionError("Tracked runs must dispatch Claude Code, not Codex")

    async def unexpected_send(*_args, **_kwargs):
        raise AssertionError("Fresh Claude Code startup must carry its own prompt")

    monkeypatch.setattr(service.tmux_service, "require_workspace_session", fake_require)
    monkeypatch.setattr(service.tmux_service, "create_session", fake_create)
    monkeypatch.setattr(service.tmux_service, "start_claude", fake_start_claude)
    monkeypatch.setattr(service.tmux_service, "start_codex", unexpected_start_codex)
    monkeypatch.setattr(service.tmux_service, "send_input", unexpected_send)

    async with _temporary_db(tmp_path) as db:
        await _seed_task(db, workspace)
        result = await service.launch_task_research(db, "task-abcdef123456")

        run = await db.scalar(select(service.run_service.Run))
        assert run is not None
        assert run.agent == "claude"
        assert run.task_id == "task-abcdef123456"
        assert run.session_name == result.session_name

    assert result.reused is False
    assert [event[0] for event in events] == [
        "create",
        "start_claude",
    ]
    assert events[0] == ("create", "shell")
    assert events[1][1:3] == (workspace.resolve(), result.session_name)
    assert "Dolphin task research-only assignment" in events[1][3]
    assert events[1][4] == run.id


@pytest.mark.asyncio
async def test_first_launch_delivers_research_prompt_atomically_with_claude_start(
    tmp_path,
    monkeypatch,
):
    service = _load_service()
    workspace = tmp_path / "projects" / "dolphin"
    workspace.mkdir(parents=True)
    monkeypatch.setenv("DOLPHIN_WORKSPACE_ROOTS", str(tmp_path / "projects"))
    started: list[tuple[Path, str, str | None, str | None]] = []
    pasted: list[tuple[Path, str, str]] = []

    async def fake_require(_path: Path, _name: str):
        raise TmuxServiceError("missing", 404)

    async def fake_create(
        path: Path,
        _project_name: str,
        requested_name: str | None = None,
        mode: str = "shell",
    ):
        assert requested_name is not None
        assert mode == "shell"
        return _shell_session(requested_name, path)

    async def fake_start_claude(
        path: Path,
        name: str,
        initial_prompt: str | None = None,
        run_id: str | None = None,
    ):
        started.append((path, name, initial_prompt, run_id))

    async def unexpected_start_codex(*_args, **_kwargs):
        raise AssertionError("Tracked runs must dispatch Claude Code, not Codex")

    async def fake_send(
        path: Path,
        name: str,
        text: str,
        enter: bool = True,
        **_kwargs,
    ):
        assert enter is True
        pasted.append((path, name, text))

    monkeypatch.setattr(service.tmux_service, "require_workspace_session", fake_require)
    monkeypatch.setattr(service.tmux_service, "create_session", fake_create)
    monkeypatch.setattr(service.tmux_service, "start_claude", fake_start_claude)
    monkeypatch.setattr(service.tmux_service, "start_codex", unexpected_start_codex)
    monkeypatch.setattr(service.tmux_service, "send_input", fake_send)

    async with _temporary_db(tmp_path) as db:
        await _seed_task(db, workspace)
        result = await service.launch_task_research(db, "task-abcdef123456")

    assert len(started) == 1
    assert started[0][:2] == (workspace.resolve(), result.session_name)
    initial_prompt = started[0][2]
    assert initial_prompt is not None
    assert "Dolphin task research-only assignment" in initial_prompt
    assert "task-abcdef123456" in initial_prompt
    run_id = started[0][3]
    assert run_id is not None
    assert pasted == []


@pytest.mark.asyncio
async def test_repeated_launch_is_idempotent_and_never_sends_a_second_prompt(
    tmp_path,
    monkeypatch,
):
    service = _load_service()
    workspace = tmp_path / "projects" / "dolphin"
    workspace.mkdir(parents=True)
    monkeypatch.setenv("DOLPHIN_WORKSPACE_ROOTS", str(tmp_path / "projects"))
    created = 0
    sent = 0
    live_sessions: dict[str, TmuxSessionInfo] = {}

    async def fake_require(path: Path, name: str):
        if name not in live_sessions:
            raise TmuxServiceError("missing", 404)
        return live_sessions[name]

    async def fake_create(
        path: Path,
        project_name: str,
        requested_name: str | None = None,
        mode: str = "shell",
    ):
        nonlocal created
        created += 1
        assert requested_name is not None
        live_sessions[requested_name] = _session(requested_name, path)
        return live_sessions[requested_name]

    async def fake_send(
        path: Path,
        name: str,
        text: str,
        enter: bool = True,
        **_kwargs,
    ):
        nonlocal sent
        sent += 1

    monkeypatch.setattr(service.tmux_service, "require_workspace_session", fake_require)
    monkeypatch.setattr(service.tmux_service, "create_session", fake_create)
    monkeypatch.setattr(service.tmux_service, "send_input", fake_send)

    async with _temporary_db(tmp_path) as db:
        await _seed_task(db, workspace)
        first = await service.launch_task_research(db, "task-abcdef123456")
        second = await service.launch_task_research(db, "task-abcdef123456")

    assert second.session_name == first.session_name
    assert second.reused is True
    assert created == 1
    assert sent == 1


@pytest.mark.asyncio
async def test_existing_task_owned_shell_starts_claude_with_prompt(
    tmp_path,
    monkeypatch,
):
    service = _load_service()
    workspace = tmp_path / "projects" / "dolphin"
    workspace.mkdir(parents=True)
    monkeypatch.setenv("DOLPHIN_WORKSPACE_ROOTS", str(tmp_path / "projects"))
    events: list[tuple] = []

    async def fake_require(path: Path, name: str):
        return _shell_session(name, path)

    async def unexpected_create(*_args, **_kwargs):
        raise AssertionError("The existing task-owned shell must be reused")

    async def fake_start_claude(
        path: Path,
        name: str,
        initial_prompt: str | None = None,
        run_id: str | None = None,
    ):
        events.append(("start_claude", path, name, initial_prompt, run_id))

    async def unexpected_start_codex(*_args, **_kwargs):
        raise AssertionError("Tracked runs must dispatch Claude Code, not Codex")

    async def unexpected_send(*_args, **_kwargs):
        raise AssertionError("Fresh Claude Code startup must carry its own prompt")

    monkeypatch.setattr(service.tmux_service, "require_workspace_session", fake_require)
    monkeypatch.setattr(service.tmux_service, "create_session", unexpected_create)
    monkeypatch.setattr(service.tmux_service, "start_claude", fake_start_claude)
    monkeypatch.setattr(service.tmux_service, "start_codex", unexpected_start_codex)
    monkeypatch.setattr(service.tmux_service, "send_input", unexpected_send)

    async with _temporary_db(tmp_path) as db:
        await _seed_task(db, workspace)
        result = await service.launch_task_research(db, "task-abcdef123456")

    assert result.reused is True
    assert [event[0] for event in events] == ["start_claude"]
    assert events[0][1:3] == (workspace.resolve(), result.session_name)
    assert "Dolphin task research-only assignment" in events[0][3]
    assert events[0][4] is not None


@pytest.mark.asyncio
async def test_hand_started_claude_session_fails_launch_without_orphaning_a_run(
    tmp_path,
    monkeypatch,
):
    """DOLPHIN_RUN_ID can only enter an agent's environment at launch.

    If Claude Code is already running in the task's session -- e.g. the
    operator typed `claude` by hand before the first Dolphin-driven launch,
    or an earlier launch attempt partially failed -- that process is
    fundamentally untrackable: there is no way to retrofit the run id into
    its environment. The launch must fail honestly rather than create a
    `dispatched` Run that can never receive a receipt and can never close
    (regression: an earlier version of this code let `is_codex_running` alone
    gate the fresh-dispatch branch, so this exact session shape slipped past
    it, created a Run, and then start_claude's own idempotency check
    silently no-opped -- a phantom Run with nothing tracking it).
    """
    service = _load_service()
    workspace = tmp_path / "projects" / "dolphin"
    workspace.mkdir(parents=True)
    monkeypatch.setenv("DOLPHIN_WORKSPACE_ROOTS", str(tmp_path / "projects"))

    async def fake_require(path: Path, name: str):
        return _claude_session(name, path)

    async def unexpected_create(*_args, **_kwargs):
        raise AssertionError("The existing task-owned session must be reused")

    async def unexpected_start_claude(*_args, **_kwargs):
        raise AssertionError(
            "Claude Code is already running in this session; it must not be "
            "(re)started, and no Run may be created for it"
        )

    async def unexpected_start_codex(*_args, **_kwargs):
        raise AssertionError("Tracked runs must dispatch Claude Code, not Codex")

    async def forbidden_run_tmux(*_args, **_kwargs):
        raise AssertionError(
            "The untrackable-agent case must fail before touching tmux at all"
        )

    monkeypatch.setattr(service.tmux_service, "require_workspace_session", fake_require)
    monkeypatch.setattr(service.tmux_service, "create_session", unexpected_create)
    monkeypatch.setattr(service.tmux_service, "start_claude", unexpected_start_claude)
    monkeypatch.setattr(service.tmux_service, "start_codex", unexpected_start_codex)
    # send_input is deliberately NOT monkeypatched: its real require_codex
    # guard (session.is_codex_running is False here) is what must produce the
    # honest failure. It raises before touching tmux, but these guards make
    # that non-negotiable rather than incidental.
    monkeypatch.setattr(service.tmux_service, "_run_tmux", forbidden_run_tmux)
    monkeypatch.setattr(
        service.tmux_service, "_run_tmux_with_input", forbidden_run_tmux
    )

    async with _temporary_db(tmp_path) as db:
        await _seed_task(db, workspace)

        with pytest.raises(service.TaskResearchLaunchError):
            await service.launch_task_research(db, "task-abcdef123456")

        runs = (await db.scalars(select(service.run_service.Run))).all()
        assert runs == []

        workflow = await db.scalar(
            select(service.TaskWorkflow).where(
                service.TaskWorkflow.task_id == "task-abcdef123456"
            )
        )
        assert workflow is not None
        assert workflow.research_status == "failed"
        assert workflow.prompt_sent_at is None


@pytest.mark.asyncio
async def test_start_claude_raising_fails_the_run_instead_of_leaving_it_phantom(
    tmp_path,
    monkeypatch,
):
    """CRITICAL 1. `create_run` commits before `start_claude` is awaited. If
    `start_claude` raises (its own readiness timeout, a tmux error, anything),
    the card is rolled back to `todo` / `research_status="failed"` -- but
    before this fix the Run it had just created was never touched, so it sat
    at `dispatched` forever: its tmux session still exists (start_claude sent
    real keystrokes before failing to observe readiness), so
    `reconcile_runs` never abandons it either. A permanent phantom.
    """
    service = _load_service()
    workspace = tmp_path / "projects" / "dolphin"
    workspace.mkdir(parents=True)
    monkeypatch.setenv("DOLPHIN_WORKSPACE_ROOTS", str(tmp_path / "projects"))

    async def fake_require(_path: Path, _name: str):
        raise TmuxServiceError("missing", 404)

    async def fake_create(
        path: Path,
        _project_name: str,
        requested_name: str | None = None,
        mode: str = "shell",
    ):
        return _shell_session(requested_name, path)

    async def failing_start_claude(*_args, **_kwargs):
        # Mirrors start_claude's own readiness-timeout wording.
        raise TmuxServiceError(
            "Claude Code did not become ready in dolphin-task within 30 "
            "seconds. The shell was kept open; inspect its terminal output "
            "and retry.",
            503,
        )

    monkeypatch.setattr(service.tmux_service, "require_workspace_session", fake_require)
    monkeypatch.setattr(service.tmux_service, "create_session", fake_create)
    monkeypatch.setattr(service.tmux_service, "start_claude", failing_start_claude)

    async with _temporary_db(tmp_path) as db:
        await _seed_task(db, workspace)

        with pytest.raises(service.TaskResearchLaunchError):
            await service.launch_task_research(db, "task-abcdef123456")

        run = await db.scalar(select(service.run_service.Run))
        assert run is not None, "the run created before dispatch must still exist"
        assert run.state == "failed"
        assert run.error is not None and "shell was kept open" in run.error

        workflow = await db.scalar(
            select(service.TaskWorkflow).where(
                service.TaskWorkflow.task_id == "task-abcdef123456"
            )
        )
        assert workflow.research_status == "failed"


@pytest.mark.asyncio
async def test_tracked_dispatch_prompt_names_the_exact_receipt_path(
    tmp_path,
    monkeypatch,
):
    """IMPORTANT 7. Spec §7 puts the receipt's shape and path in the dispatch
    prompt. Without it, turn 1 of every tracked run ends with no receipt on
    disk, guaranteeing the hook blocks and forces a re-prompt every time.
    """
    service = _load_service()
    workspace = tmp_path / "projects" / "dolphin"
    workspace.mkdir(parents=True)
    monkeypatch.setenv("DOLPHIN_WORKSPACE_ROOTS", str(tmp_path / "projects"))
    started: list[tuple] = []

    async def fake_require(_path: Path, _name: str):
        raise TmuxServiceError("missing", 404)

    async def fake_create(
        path: Path,
        _project_name: str,
        requested_name: str | None = None,
        mode: str = "shell",
    ):
        return _shell_session(requested_name, path)

    async def fake_start_claude(
        path: Path,
        name: str,
        initial_prompt: str | None = None,
        run_id: str | None = None,
    ):
        started.append((path, name, initial_prompt, run_id))

    monkeypatch.setattr(service.tmux_service, "require_workspace_session", fake_require)
    monkeypatch.setattr(service.tmux_service, "create_session", fake_create)
    monkeypatch.setattr(service.tmux_service, "start_claude", fake_start_claude)

    async with _temporary_db(tmp_path) as db:
        await _seed_task(db, workspace)
        await service.launch_task_research(db, "task-abcdef123456")

        run = await db.scalar(select(service.run_service.Run))
        assert run is not None

    assert len(started) == 1
    prompt = started[0][2]
    expected_path = str(
        service.receipts.receipt_path(str(workspace.resolve()), run.id)
    )
    assert expected_path in prompt
    assert expected_path.endswith(f".dolphin/runs/{run.id}/receipt.md")
    assert "receipt" in prompt.lower()


@pytest.mark.asyncio
async def test_existing_codex_session_skips_duplicate_start_before_prompt(
    tmp_path,
    monkeypatch,
):
    service = _load_service()
    workspace = tmp_path / "projects" / "dolphin"
    workspace.mkdir(parents=True)
    monkeypatch.setenv("DOLPHIN_WORKSPACE_ROOTS", str(tmp_path / "projects"))
    prompts: list[tuple] = []

    async def fake_require(path: Path, name: str):
        return _session(name, path)

    async def unexpected_create(*_args, **_kwargs):
        raise AssertionError("The existing task-owned session must be reused")

    async def unexpected_start_codex(*_args, **_kwargs):
        raise AssertionError("Ready Codex must not receive a duplicate start")

    async def fake_send(
        path: Path,
        name: str,
        text: str,
        enter: bool = True,
        *,
        require_codex: bool = False,
    ):
        prompts.append((path, name, text, enter, require_codex))

    monkeypatch.setattr(service.tmux_service, "require_workspace_session", fake_require)
    monkeypatch.setattr(service.tmux_service, "create_session", unexpected_create)
    monkeypatch.setattr(
        service.tmux_service,
        "start_codex",
        unexpected_start_codex,
    )
    monkeypatch.setattr(service.tmux_service, "send_input", fake_send)

    async with _temporary_db(tmp_path) as db:
        await _seed_task(db, workspace)
        result = await service.launch_task_research(db, "task-abcdef123456")

    assert result.reused is True
    assert len(prompts) == 1
    assert prompts[0][0:2] == (workspace.resolve(), result.session_name)
    assert prompts[0][3] is True
    assert prompts[0][4] is True


@pytest.mark.asyncio
async def test_concurrent_launch_requests_share_one_session_and_prompt(
    tmp_path,
    monkeypatch,
):
    service = _load_service()
    workspace = tmp_path / "projects" / "dolphin"
    workspace.mkdir(parents=True)
    monkeypatch.setenv("DOLPHIN_WORKSPACE_ROOTS", str(tmp_path / "projects"))
    engine = create_async_engine(
        f"sqlite+aiosqlite:///{tmp_path / 'concurrent-task-workflow.db'}"
    )
    sessions = async_sessionmaker(
        engine,
        class_=AsyncSession,
        expire_on_commit=False,
    )
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    created = 0
    sent = 0
    live_sessions: dict[str, TmuxSessionInfo] = {}

    async def fake_require(path: Path, name: str):
        if name not in live_sessions:
            raise TmuxServiceError("missing", 404)
        return live_sessions[name]

    async def fake_create(
        path: Path,
        project_name: str,
        requested_name: str | None = None,
        mode: str = "shell",
    ):
        nonlocal created
        created += 1
        assert requested_name is not None
        await asyncio.sleep(0)
        live_sessions[requested_name] = _session(requested_name, path)
        return live_sessions[requested_name]

    async def fake_send(
        path: Path,
        name: str,
        text: str,
        enter: bool = True,
        **_kwargs,
    ):
        nonlocal sent
        sent += 1
        await asyncio.sleep(0)

    monkeypatch.setattr(service.tmux_service, "require_workspace_session", fake_require)
    monkeypatch.setattr(service.tmux_service, "create_session", fake_create)
    monkeypatch.setattr(service.tmux_service, "send_input", fake_send)

    try:
        async with sessions() as seed_db:
            await _seed_task(seed_db, workspace)
        async with sessions() as first_db, sessions() as second_db:
            first, second = await asyncio.gather(
                service.launch_task_research(first_db, "task-abcdef123456"),
                service.launch_task_research(second_db, "task-abcdef123456"),
            )
    finally:
        await engine.dispose()

    assert first.session_name == second.session_name
    assert {first.reused, second.reused} == {False, True}
    assert created == 1
    assert sent == 1


@pytest.mark.asyncio
async def test_launch_failure_rolls_card_back_and_preserves_recovery_detail(
    tmp_path,
    monkeypatch,
):
    service = _load_service()
    workspace = tmp_path / "projects" / "dolphin"
    workspace.mkdir(parents=True)
    monkeypatch.setenv("DOLPHIN_WORKSPACE_ROOTS", str(tmp_path / "projects"))

    async def fake_require(path: Path, name: str):
        raise TmuxServiceError("missing", 404)

    async def fake_create(*_args, **_kwargs):
        raise TmuxServiceError("tmux refused the exact session", 503)

    async def unexpected_send(*_args, **_kwargs):
        raise AssertionError("A prompt must not be sent when session creation fails")

    monkeypatch.setattr(service.tmux_service, "require_workspace_session", fake_require)
    monkeypatch.setattr(service.tmux_service, "create_session", fake_create)
    monkeypatch.setattr(service.tmux_service, "send_input", unexpected_send)

    async with _temporary_db(tmp_path) as db:
        await _seed_task(db, workspace)

        with pytest.raises(service.TaskResearchLaunchError) as exc_info:
            await service.launch_task_research(db, "task-abcdef123456")

        assert "tmux refused the exact session" in exc_info.value.detail
        workflow = await db.scalar(
            select(service.TaskWorkflow).where(
                service.TaskWorkflow.task_id == "task-abcdef123456"
            )
        )
        assert workflow is not None
        assert workflow.state == "todo"
        assert workflow.research_status == "failed"
        assert workflow.launch_error == "tmux refused the exact session"
        assert workflow.session_name.startswith("dolphin-task-build-the-agent-kanban-")
        assert workflow.prompt_sent_at is None


@pytest.mark.asyncio
async def test_research_brief_and_done_reopen_transitions_are_durable(tmp_path):
    service = _load_service()
    workspace = tmp_path / "projects" / "dolphin"
    workspace.mkdir(parents=True)

    async with _temporary_db(tmp_path) as db:
        task = await _seed_task(db, workspace)
        workflow = await service.get_or_create_workflow(db, task)
        workflow.state = "in_progress"
        workflow.research_status = "researching"
        await db.commit()

        ready = await service.submit_research_brief(
            db,
            task.id,
            "# Research brief\n\nUse the existing control-center snapshot.",
        )
        assert ready.research_status == "ready"
        assert "Research brief" in ready.research_brief

        await service.set_task_workflow_state(db, task, "done")
        await db.commit()
        assert task.is_done is True
        assert task.completed_at is not None
        assert task.workflow.state == "done"

        await service.set_task_workflow_state(db, task, "review")
        await db.commit()
        assert task.is_done is False
        assert task.completed_at is None
        assert task.workflow.state == "review"


@pytest.mark.asyncio
async def test_ready_task_input_targets_only_its_exact_codex_session(
    tmp_path,
    monkeypatch,
):
    service = _load_service()
    workspace = tmp_path / "projects" / "dolphin"
    workspace.mkdir(parents=True)
    monkeypatch.setenv("DOLPHIN_WORKSPACE_ROOTS", str(tmp_path / "projects"))
    sent: list[tuple[Path, str, str, bool, bool]] = []

    async def fake_send(
        path: Path,
        name: str,
        text: str,
        enter: bool = True,
        require_codex: bool = False,
    ):
        sent.append((path, name, text, enter, require_codex))

    monkeypatch.setattr(service.tmux_service, "send_input", fake_send)

    async with _temporary_db(tmp_path) as db:
        task = await _seed_task(db, workspace)
        workflow = await _ready_workflow(service, db, task, workspace)
        before = (
            workflow.state,
            workflow.research_status,
            workflow.research_brief,
            workflow.updated_at,
            task.project_id,
        )
        message = "  Approve the plan.\nPreserve exact-session safety.  "

        result = await service.send_task_research_input(db, task.id, message)

        assert result.task_id == task.id
        assert result.session_name == workflow.session_name
        assert result.status == "sent"
        assert sent == [
            (
                workspace.resolve(),
                workflow.session_name,
                message,
                True,
                True,
            )
        ]
        assert (
            workflow.state,
            workflow.research_status,
            workflow.research_brief,
            workflow.updated_at,
            task.project_id,
        ) == before


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("invalid_case", "expected_detail", "expected_status"),
    [
        ("done", "reopened", 409),
        ("researching", "plan is ready", 409),
        ("missing_brief", "plan is ready", 409),
        ("missing_session", "linked Codex session", 409),
        ("missing_workspace", "linked workspace", 409),
        ("blank_input", "empty", 422),
    ],
)
async def test_task_input_fails_closed_before_tmux_for_invalid_workflow_state(
    tmp_path,
    monkeypatch,
    invalid_case,
    expected_detail,
    expected_status,
):
    service = _load_service()
    workspace = tmp_path / "projects" / "dolphin"
    workspace.mkdir(parents=True)
    monkeypatch.setenv("DOLPHIN_WORKSPACE_ROOTS", str(tmp_path / "projects"))

    async def fail_if_called(*_args, **_kwargs):
        raise AssertionError("tmux input must not run for an invalid task workflow")

    monkeypatch.setattr(service.tmux_service, "send_input", fail_if_called)

    async with _temporary_db(tmp_path) as db:
        task = await _seed_task(db, workspace)
        workflow = await _ready_workflow(service, db, task, workspace)
        text = "Continue with the approved plan."
        if invalid_case == "done":
            workflow.state = "done"
            task.is_done = True
        elif invalid_case == "researching":
            workflow.research_status = "researching"
        elif invalid_case == "missing_brief":
            workflow.research_brief = "   "
        elif invalid_case == "missing_session":
            workflow.session_name = None
        elif invalid_case == "missing_workspace":
            workflow.placement_workspace_path = None
        elif invalid_case == "blank_input":
            text = " \n\t "
        await db.commit()

        with pytest.raises(service.TaskResearchLaunchError) as exc_info:
            await service.send_task_research_input(db, task.id, text)

        assert exc_info.value.status_code == expected_status
        assert expected_detail in exc_info.value.detail


@pytest.mark.asyncio
async def test_reopened_task_launches_a_fresh_session_and_prompt(
    tmp_path,
    monkeypatch,
):
    service = _load_service()
    workspace = tmp_path / "projects" / "dolphin"
    workspace.mkdir(parents=True)
    monkeypatch.setenv("DOLPHIN_WORKSPACE_ROOTS", str(tmp_path / "projects"))

    created: list[tuple[Path, str, str | None, str]] = []
    sent: list[tuple[Path, str, str, bool]] = []

    async def fake_require(_path: Path, _name: str):
        raise TmuxServiceError("missing", 404)

    async def fake_create(
        path: Path,
        project_name: str,
        requested_name: str | None = None,
        mode: str = "shell",
    ):
        created.append((path, project_name, requested_name, mode))
        assert requested_name is not None
        return _session(requested_name, path)

    async def fake_send(
        path: Path,
        name: str,
        text: str,
        enter: bool = True,
        **_kwargs,
    ):
        sent.append((path, name, text, enter))

    monkeypatch.setattr(service.tmux_service, "require_workspace_session", fake_require)
    monkeypatch.setattr(service.tmux_service, "create_session", fake_create)
    monkeypatch.setattr(service.tmux_service, "send_input", fake_send)

    async with _temporary_db(tmp_path) as db:
        task = await _seed_task(db, workspace)
        workflow = await service.get_or_create_workflow(db, task)
        workflow.state = "done"
        workflow.session_name = service.make_task_session_name(
            project_name="Dolphin Tasks",
            task_title=task.title,
            task_id=task.id,
        )
        workflow.research_status = "ready"
        workflow.research_brief = "Stale brief from the closed run."
        workflow.prompt_sent_at = datetime.now(timezone.utc)
        workflow.started_at = workflow.prompt_sent_at
        workflow.research_completed_at = workflow.prompt_sent_at
        workflow.placement_kind = "explicit_project"
        workflow.placement_project_id = "project-1"
        workflow.placement_project_name = "Dolphin Tasks"
        workflow.placement_workspace_path = str(workspace.resolve())
        workflow.placement_reason = "Explicit project."
        workflow.placement_confidence = 100
        workflow.cleanup_status = "not_applicable"
        task.is_done = True
        task.completed_at = workflow.prompt_sent_at
        await db.commit()

        await service.set_task_workflow_state(db, task, "todo")
        await db.commit()
        result = await service.launch_task_research(db, task.id)

        assert result.reused is False
        assert result.research_status == "researching"
        assert len(created) == 1
        assert created[0] == (
            workspace.resolve(),
            "Dolphin Tasks",
            result.session_name,
            "shell",
        )
        assert len(sent) == 1
        assert sent[0][0] == workspace.resolve()
        assert sent[0][1] == result.session_name
        assert sent[0][3] is True
        assert workflow.research_brief == ""
        assert workflow.research_completed_at is None
