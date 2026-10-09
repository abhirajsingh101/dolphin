"""HTTP guards for the review-queue endpoints (Stage 4 tasks 1-4).

The lifespan protocol is deliberately never entered here, for the reason
spelled out in test_run_events_api.py: `app.main`'s startup event snapshots
and migrates the real database as a side effect of importing the app.
httpx's ASGITransport only ever delivers HTTP scopes, so `on_event("startup")`
never fires and the dependency override below is the only database the app
sees.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.database import Base, get_db
from app.main import app
from app import run_service, task_workflow_service, tmux_service
from app.models import Project, Task, TaskWorkflow
from app.tmux_service import TmuxSessionInfo


@pytest_asyncio.fixture
async def client(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'queue.db'}")
    sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async def _override_get_db():
        async with sessions() as db:
            yield db

    app.dependency_overrides[get_db] = _override_get_db
    transport = ASGITransport(app=app)
    try:
        async with AsyncClient(transport=transport, base_url="http://test") as http_client:
            yield http_client, sessions
    finally:
        app.dependency_overrides.pop(get_db, None)
        await engine.dispose()


@pytest.mark.asyncio
async def test_unknown_state_filter_is_refused(client):
    """A typo must not be indistinguishable from an empty queue."""
    http_client, _sessions = client
    response = await http_client.get("/api/runs", params={"state": "bogus"})
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_one_bad_state_among_good_ones_is_still_refused(client):
    http_client, _sessions = client
    response = await http_client.get(
        "/api/runs", params=[("state", "needs_review"), ("state", "bogus")]
    )
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_every_real_run_state_is_accepted(client):
    """The enum must not drift from run_service.RUN_STATES."""
    http_client, _sessions = client
    for state in sorted(run_service.RUN_STATES):
        response = await http_client.get("/api/runs", params={"state": state})
        assert response.status_code == 200, state
        assert response.json() == []


async def _seed_task(sessions, *, task_id="task-1", project_id="proj-1",
                     title="Ship the queue", project_name="Dolphin"):
    at = datetime(2026, 8, 9, 12, 0, tzinfo=timezone.utc)
    async with sessions() as db:
        db.add(Project(id=project_id, name=project_name, emoji="🐬",
                       color="#176B87", path="/tmp/ws", position=0,
                       created_at=at, updated_at=at))
        db.add(Task(id=task_id, project_id=project_id, title=title,
                    description="", priority=4, position=0,
                    created_at=at, updated_at=at))
        await db.commit()


@pytest.mark.asyncio
async def test_listing_carries_task_title_and_project_name(client, tmp_path):
    http_client, sessions = client
    await _seed_task(sessions)
    async with sessions() as db:
        run = await run_service.create_run(
            db, task_id="task-1", project_id="proj-1",
            session_name="s1", agent="claude", workspace_path=str(tmp_path),
        )
        await run_service.transition(db, run, "awaiting_receipt")

    response = await http_client.get("/api/runs", params={"state": "awaiting_receipt"})
    assert response.status_code == 200
    [row] = response.json()
    assert row["task_title"] == "Ship the queue"
    assert row["project_name"] == "Dolphin"
    assert row["has_receipt"] is False
    assert row["last_event_at"] is None
    assert row["session_name"] == "s1"


@pytest.mark.asyncio
async def test_listing_reports_a_receipt_once_the_gate_recorded_one(client, tmp_path):
    http_client, sessions = client
    await _seed_task(sessions)
    async with sessions() as db:
        run = await run_service.create_run(
            db, task_id="task-1", project_id="proj-1",
            session_name="s1", agent="claude", workspace_path=str(tmp_path),
        )
        run_id = run.id

    receipt = tmp_path / ".dolphin" / "runs" / run_id / "receipt.md"
    receipt.parent.mkdir(parents=True)
    receipt.write_text("# Done\n")
    await http_client.post(f"/api/runs/{run_id}/events", json={"type": "turn_end"})

    response = await http_client.get("/api/runs", params={"state": "needs_review"})
    [row] = response.json()
    assert row["has_receipt"] is True
    assert row["turn_count"] == 1
    assert row["last_event_at"] is not None


@pytest.mark.asyncio
async def test_a_run_whose_task_is_gone_does_not_list(client, tmp_path):
    """An inner join, deliberately: ON DELETE CASCADE means this set is empty
    in production, and a row with no title is not a row a human can act on."""
    http_client, sessions = client
    async with sessions() as db:
        await run_service.create_run(
            db, task_id="ghost", project_id="ghost",
            session_name="s1", agent="claude", workspace_path=str(tmp_path),
        )

    response = await http_client.get("/api/runs")
    assert response.status_code == 200
    assert response.json() == []


@pytest.mark.asyncio
async def test_receipt_is_served_for_a_run_that_has_one(client, tmp_path):
    http_client, sessions = client
    await _seed_task(sessions)
    async with sessions() as db:
        run = await run_service.create_run(
            db, task_id="task-1", project_id="proj-1",
            session_name="s1", agent="claude", workspace_path=str(tmp_path),
        )
        run_id = run.id

    receipt = tmp_path / ".dolphin" / "runs" / run_id / "receipt.md"
    receipt.parent.mkdir(parents=True)
    receipt.write_text("# What changed\n\nEverything.\n")

    response = await http_client.get(f"/api/runs/{run_id}/receipt")
    assert response.status_code == 200
    body = response.json()
    assert body["text"] == "# What changed\n\nEverything.\n"
    assert body["truncated"] is False
    assert body["path"].endswith(f".dolphin/runs/{run_id}/receipt.md")


@pytest.mark.asyncio
async def test_missing_receipt_is_404_naming_the_path_it_wanted(client, tmp_path):
    """The 404 body is the copy an awaiting_receipt row shows, so it must
    carry the exact path the agent was told to write."""
    http_client, sessions = client
    await _seed_task(sessions)
    async with sessions() as db:
        run = await run_service.create_run(
            db, task_id="task-1", project_id="proj-1",
            session_name="s1", agent="claude", workspace_path=str(tmp_path),
        )
        run_id = run.id

    response = await http_client.get(f"/api/runs/{run_id}/receipt")
    assert response.status_code == 404
    assert f".dolphin/runs/{run_id}/receipt.md" in response.json()["detail"]


@pytest.mark.asyncio
async def test_receipt_over_the_cap_is_reported_truncated(client, tmp_path):
    http_client, sessions = client
    await _seed_task(sessions)
    async with sessions() as db:
        run = await run_service.create_run(
            db, task_id="task-1", project_id="proj-1",
            session_name="s1", agent="claude", workspace_path=str(tmp_path),
        )
        run_id = run.id

    receipt = tmp_path / ".dolphin" / "runs" / run_id / "receipt.md"
    receipt.parent.mkdir(parents=True)
    receipt.write_bytes(b"x" * 300_000)

    response = await http_client.get(f"/api/runs/{run_id}/receipt")
    assert response.status_code == 200
    body = response.json()
    assert body["truncated"] is True
    assert len(body["text"].encode("utf-8")) <= 262_144


@pytest.mark.asyncio
async def test_receipt_for_an_unknown_run_is_404(client):
    http_client, _sessions = client
    response = await http_client.get("/api/runs/nope/receipt")
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_retry_dispatches_and_returns_a_new_run(client, tmp_path, monkeypatch):
    http_client, sessions = client
    await _seed_task(sessions)
    async with sessions() as db:
        old = await run_service.create_run(
            db, task_id="task-1", project_id="proj-1",
            session_name="s1", agent="claude", workspace_path=str(tmp_path),
        )
        await run_service.transition(db, old, "awaiting_receipt")
        old_id = old.id

    created: list[str] = []

    async def fake_launch(db, task_id, *, retry=False):
        assert retry is True, "the endpoint must ask for a retry dispatch"
        run = await run_service.create_run(
            db, task_id=task_id, project_id="proj-1",
            session_name="s1", agent="claude", workspace_path=str(tmp_path),
        )
        created.append(run.id)
        return None

    monkeypatch.setattr(
        task_workflow_service, "launch_task_research", fake_launch
    )

    response = await http_client.post(f"/api/runs/{old_id}/retry")
    assert response.status_code == 200
    assert response.json()["id"] == created[0]
    assert response.json()["id"] != old_id

    async with sessions() as db:
        assert (await run_service.get_run(db, old_id)).state == "dismissed"
        assert (await run_service.get_run(db, created[0])).state == "dispatched"


@pytest.mark.asyncio
async def test_a_failed_retry_leaves_the_old_run_exactly_as_it_was(client, tmp_path, monkeypatch):
    """Dismiss-then-dispatch would discard the only run holding evidence."""
    http_client, sessions = client
    await _seed_task(sessions)
    async with sessions() as db:
        old = await run_service.create_run(
            db, task_id="task-1", project_id="proj-1",
            session_name="s1", agent="claude", workspace_path=str(tmp_path),
        )
        await run_service.transition(db, old, "needs_review")
        old_id = old.id

    async def fake_launch(db, task_id, *, retry=False):
        assert retry is True, "the endpoint must ask for a retry dispatch"
        raise task_workflow_service.TaskResearchLaunchError("tmux is down", 503)

    monkeypatch.setattr(task_workflow_service, "launch_task_research", fake_launch)

    response = await http_client.post(f"/api/runs/{old_id}/retry")
    assert response.status_code == 503
    assert response.json()["detail"] == "tmux is down"

    async with sessions() as db:
        assert (await run_service.get_run(db, old_id)).state == "needs_review"


@pytest.mark.asyncio
async def test_retry_on_a_live_run_is_refused(client, tmp_path):
    http_client, sessions = client
    await _seed_task(sessions)
    async with sessions() as db:
        run = await run_service.create_run(
            db, task_id="task-1", project_id="proj-1",
            session_name="s1", agent="claude", workspace_path=str(tmp_path),
        )
        await run_service.transition(db, run, "running")
        run_id = run.id

    response = await http_client.post(f"/api/runs/{run_id}/retry")
    assert response.status_code == 409

    async with sessions() as db:
        assert len(await run_service.list_runs(db)) == 1


@pytest.mark.asyncio
async def test_retry_that_started_no_tracked_run_is_refused(client, tmp_path, monkeypatch):
    """A dispatch that recorded no Run leaves nothing tracking the work.
    Dismissing the old row in exchange for nothing would silently empty the
    queue, so the endpoint must refuse rather than report success."""
    http_client, sessions = client
    await _seed_task(sessions)
    async with sessions() as db:
        old = await run_service.create_run(
            db, task_id="task-1", project_id="proj-1",
            session_name="s1", agent="claude", workspace_path=str(tmp_path),
        )
        await run_service.transition(db, old, "abandoned")
        old_id = old.id

    async def fake_launch(db, task_id, *, retry=False):
        assert retry is True, "the endpoint must ask for a retry dispatch"
        return None  # untracked branch: no new Run row

    monkeypatch.setattr(task_workflow_service, "launch_task_research", fake_launch)

    response = await http_client.post(f"/api/runs/{old_id}/retry")
    assert response.status_code == 409

    async with sessions() as db:
        assert (await run_service.get_run(db, old_id)).state == "abandoned"


@pytest.mark.asyncio
async def test_retry_from_failed_succeeds_without_crashing(client, tmp_path, monkeypatch):
    """`failed` is terminal in `_ALLOWED` -- it has no outgoing transition at
    all, unlike `dismissed`. A successful dispatch from here must still
    return 200 with the new run, not crash trying to transition an
    already-terminal run to `dismissed`. The old run is already closed, so it
    needs no further transition and stays `failed`."""
    http_client, sessions = client
    await _seed_task(sessions)
    async with sessions() as db:
        old = await run_service.create_run(
            db, task_id="task-1", project_id="proj-1",
            session_name="s1", agent="claude", workspace_path=str(tmp_path),
        )
        await run_service.transition(db, old, "failed")
        old_id = old.id

    created: list[str] = []

    async def fake_launch(db, task_id, *, retry=False):
        assert retry is True, "the endpoint must ask for a retry dispatch"
        run = await run_service.create_run(
            db, task_id=task_id, project_id="proj-1",
            session_name="s1", agent="claude", workspace_path=str(tmp_path),
        )
        created.append(run.id)
        return None

    monkeypatch.setattr(task_workflow_service, "launch_task_research", fake_launch)

    response = await http_client.post(f"/api/runs/{old_id}/retry")
    assert response.status_code == 200
    assert response.json()["id"] == created[0]

    async with sessions() as db:
        # Already terminal, so dismissal -- which exists to close a still-open
        # run -- has nothing to do here; `failed` stands, unmutated.
        assert (await run_service.get_run(db, old_id)).state == "failed"
        assert (await run_service.get_run(db, created[0])).state == "dispatched"


@pytest.mark.asyncio
async def test_retry_from_abandoned_succeeds_without_crashing(client, tmp_path, monkeypatch):
    """`abandoned` is terminal in `_ALLOWED` -- it has no outgoing transition
    at all, unlike `dismissed`. A successful dispatch from here must still
    return 200 with the new run, not crash trying to transition an
    already-terminal run to `dismissed`. The old run is already closed, so it
    needs no further transition and stays `abandoned`."""
    http_client, sessions = client
    await _seed_task(sessions)
    async with sessions() as db:
        old = await run_service.create_run(
            db, task_id="task-1", project_id="proj-1",
            session_name="s1", agent="claude", workspace_path=str(tmp_path),
        )
        await run_service.transition(db, old, "abandoned")
        old_id = old.id

    created: list[str] = []

    async def fake_launch(db, task_id, *, retry=False):
        assert retry is True, "the endpoint must ask for a retry dispatch"
        run = await run_service.create_run(
            db, task_id=task_id, project_id="proj-1",
            session_name="s1", agent="claude", workspace_path=str(tmp_path),
        )
        created.append(run.id)
        return None

    monkeypatch.setattr(task_workflow_service, "launch_task_research", fake_launch)

    response = await http_client.post(f"/api/runs/{old_id}/retry")
    assert response.status_code == 200
    assert response.json()["id"] == created[0]

    async with sessions() as db:
        # Already terminal, so dismissal -- which exists to close a still-open
        # run -- has nothing to do here; `abandoned` stands, unmutated.
        assert (await run_service.get_run(db, old_id)).state == "abandoned"
        assert (await run_service.get_run(db, created[0])).state == "dispatched"


# ---------------------------------------------------------------------------
# Spec §9: "Retry dispatches | a new run row exists AND start_claude was
# called with its id."
#
# The tests above all replace `launch_task_research` itself, so the fake IS
# the dispatch and they can only ever prove the endpoint's bookkeeping around
# a dispatch they assume happened. That gap is exactly what let Retry ship
# dispatching nothing at all: every row this queue lists has `prompt_sent_at`
# set and a live session, so `launch_task_research` took its "prompt already
# sent" early return, created no run, and the endpoint then reported an agent
# liveness it had never evaluated. The two tests below patch the tmux surface
# instead and let the real launcher run.
# ---------------------------------------------------------------------------


def _shell_session(name: str, path) -> TmuxSessionInfo:
    return TmuxSessionInfo(
        name=name,
        path=str(path),
        created_at=datetime(2026, 8, 9, 11, 0, tzinfo=timezone.utc),
        windows=1,
        attached=False,
        current_command="bash",
        is_codex_running=False,
    )


def _claude_session(name: str, path) -> TmuxSessionInfo:
    return TmuxSessionInfo(
        name=name,
        path=str(path),
        created_at=datetime(2026, 8, 9, 11, 0, tzinfo=timezone.utc),
        windows=1,
        attached=False,
        current_command="claude",
        is_codex_running=False,
        is_claude_code_running=True,
    )


SESSION_NAME = "dolphin-task-ship-the-queue-a1b2c3d4"


async def _seed_dispatched_task(sessions, workspace, *, workflow_state="in_progress"):
    """A task mid-run: prompt already sent, session named, placement resolved.

    This is the shape of every row the review queue lists, which is the whole
    point -- `prompt_sent_at` is written after each successful dispatch and
    cleared only when the session is found gone, and a run whose session died
    is swept to `abandoned` and leaves the queue.
    """
    at = datetime(2026, 8, 9, 12, 0, tzinfo=timezone.utc)
    async with sessions() as db:
        db.add(Project(id="proj-1", name="Dolphin", emoji="🐬",
                       color="#176B87", path=str(workspace), position=0,
                       created_at=at, updated_at=at))
        db.add(Task(id="task-1", project_id="proj-1", title="Ship the queue",
                    description="", priority=4, position=0,
                    created_at=at, updated_at=at))
        db.add(TaskWorkflow(
            task_id="task-1",
            state=workflow_state,
            session_name=SESSION_NAME,
            research_status="researching",
            research_brief="",
            prompt_sent_at=at,
            started_at=at,
            placement_kind="explicit_project",
            placement_project_id="proj-1",
            placement_project_name="Dolphin",
            placement_workspace_path=str(workspace),
            placement_reason="You selected Dolphin.",
            placement_confidence=100,
            created_at=at,
            updated_at=at,
        ))
        await db.commit()


@pytest.mark.asyncio
async def test_retry_creates_a_run_and_starts_claude_with_its_id(
    client, tmp_path, monkeypatch
):
    """Spec §9's "Retry dispatches" property, held against the real launcher.

    RED before the `retry=True` flag existed: `launch_task_research` returned
    at its `prompt_sent_at` early branch, so no run was created, `start_claude`
    was never called, and the endpoint answered 409.
    """
    http_client, sessions = client
    workspace = tmp_path / "projects" / "dolphin"
    workspace.mkdir(parents=True)
    monkeypatch.setenv("DOLPHIN_WORKSPACE_ROOTS", str(tmp_path / "projects"))
    await _seed_dispatched_task(sessions, workspace.resolve())

    async with sessions() as db:
        old = await run_service.create_run(
            db, task_id="task-1", project_id="proj-1",
            session_name=SESSION_NAME, agent="claude",
            workspace_path=str(workspace.resolve()),
        )
        await run_service.transition(db, old, "awaiting_receipt")
        old_id = old.id

    started: list[tuple] = []

    async def fake_require(path, name):
        # The session is alive -- it is the operator exiting the agent, not
        # the session dying, that makes a retry possible -- but no agent is
        # running in it.
        return _shell_session(name, path)

    async def unexpected_create(*_args, **_kwargs):
        raise AssertionError("The live task-owned session must be reused")

    async def fake_start_claude(path, name, initial_prompt=None, run_id=None):
        started.append((path, name, initial_prompt, run_id))

    async def unexpected_send(*_args, **_kwargs):
        raise AssertionError("A fresh Claude Code start carries its own prompt")

    monkeypatch.setattr(tmux_service, "require_workspace_session", fake_require)
    monkeypatch.setattr(tmux_service, "create_session", unexpected_create)
    monkeypatch.setattr(tmux_service, "start_claude", fake_start_claude)
    monkeypatch.setattr(tmux_service, "send_input", unexpected_send)

    response = await http_client.post(f"/api/runs/{old_id}/retry")
    assert response.status_code == 200, response.json()
    new_id = response.json()["id"]
    assert new_id != old_id

    async with sessions() as db:
        runs = await run_service.list_runs(db)
        assert {run.id for run in runs} == {old_id, new_id}
        new_run = await run_service.get_run(db, new_id)
        assert new_run.state == "dispatched"
        assert new_run.session_name == SESSION_NAME
        assert (await run_service.get_run(db, old_id)).state == "dismissed"

    # The half of the property the endpoint-level tests could never reach:
    # an agent was actually started, and it carries the new run's id, which
    # is the only way DOLPHIN_RUN_ID reaches the Stop hook.
    assert len(started) == 1
    assert started[0][3] == new_id
    assert started[0][1] == SESSION_NAME
    assert new_id in started[0][2], "the prompt must name this run's receipt path"


@pytest.mark.asyncio
async def test_retry_is_refused_while_an_agent_is_alive_and_moves_nothing(
    client, tmp_path, monkeypatch
):
    """DOLPHIN_RUN_ID can only enter an agent's environment at launch, so a
    tracked retry into a live agent is impossible. The refusal must come
    before anything is mutated -- an action that reports failure must not
    have moved the card on its way out -- and it must say what was observed
    and what to do next.
    """
    http_client, sessions = client
    workspace = tmp_path / "projects" / "dolphin"
    workspace.mkdir(parents=True)
    monkeypatch.setenv("DOLPHIN_WORKSPACE_ROOTS", str(tmp_path / "projects"))
    await _seed_dispatched_task(sessions, workspace.resolve(), workflow_state="review")

    async with sessions() as db:
        old = await run_service.create_run(
            db, task_id="task-1", project_id="proj-1",
            session_name=SESSION_NAME, agent="claude",
            workspace_path=str(workspace.resolve()),
        )
        await run_service.transition(db, old, "awaiting_receipt")
        old_id = old.id

    async def fake_require(path, name):
        return _claude_session(name, path)

    async def unexpected_start_claude(*_args, **_kwargs):
        raise AssertionError("A live agent must not be dispatched over")

    async def unexpected_send(*_args, **_kwargs):
        raise AssertionError("A live agent must not be sent a retry prompt")

    async def unexpected_kill(*_args, **_kwargs):
        raise AssertionError("Retry must never destroy a running agent")

    monkeypatch.setattr(tmux_service, "require_workspace_session", fake_require)
    monkeypatch.setattr(tmux_service, "start_claude", unexpected_start_claude)
    monkeypatch.setattr(tmux_service, "send_input", unexpected_send)
    monkeypatch.setattr(tmux_service, "kill_session", unexpected_kill)

    response = await http_client.post(f"/api/runs/{old_id}/retry")
    assert response.status_code == 409

    async with sessions() as db:
        # Nothing moved: not the board, not the run, not the run count. This
        # is the assertion that fails loudest against the old code, which
        # committed the card into In Progress and then reported failure.
        workflow = await db.get(TaskWorkflow, "task-1")
        assert workflow.state == "review"
        assert workflow.research_status == "researching"
        assert (await run_service.get_run(db, old_id)).state == "awaiting_receipt"
        assert len(await run_service.list_runs(db)) == 1

    # And it says what was observed and what to do next, rather than asserting
    # a liveness it never evaluated.
    detail = response.json()["detail"]
    assert "still running" in detail
    assert "exit it" in detail


@pytest.mark.asyncio
async def test_retry_never_returns_a_pre_existing_newer_run_as_the_new_one(
    client, tmp_path, monkeypatch
):
    """Two open runs on one task is reachable: kill a session, press play
    (same session name, so the old `awaiting_receipt` run is never abandoned).
    Inferring "a new run was created" from "the newest run is not the one I
    retried" then dismisses the retried run and hands back an unrelated
    pre-existing run as the retry's result, with 200.
    """
    http_client, sessions = client
    await _seed_task(sessions)
    older = datetime(2026, 8, 9, 9, 0, tzinfo=timezone.utc)
    newer = datetime(2026, 8, 9, 11, 0, tzinfo=timezone.utc)

    async with sessions() as db:
        retried = await run_service.create_run(
            db, task_id="task-1", project_id="proj-1",
            session_name="s1", agent="claude", workspace_path=str(tmp_path),
        )
        await run_service.transition(db, retried, "awaiting_receipt")
        retried.dispatched_at = older
        second = await run_service.create_run(
            db, task_id="task-1", project_id="proj-1",
            session_name="s1", agent="claude", workspace_path=str(tmp_path),
        )
        second.dispatched_at = newer
        await db.commit()
        retried_id, second_id = retried.id, second.id

    async def fake_launch(db, task_id, *, retry=False):
        assert retry is True
        return None  # dispatched nothing, recorded nothing

    monkeypatch.setattr(task_workflow_service, "launch_task_research", fake_launch)

    response = await http_client.post(f"/api/runs/{retried_id}/retry")
    assert response.status_code == 409
    assert second_id not in response.text

    async with sessions() as db:
        assert (await run_service.get_run(db, retried_id)).state == "awaiting_receipt"
        assert (await run_service.get_run(db, second_id)).state == "dispatched"
        assert len(await run_service.list_runs(db)) == 2


def _degraded_session(name: str, path) -> TmuxSessionInfo:
    """What `_build_session_info` produces when the pane probe fails.

    Both agent flags are `False` *by construction* there -- they are derived
    from pane observations that could not be collected -- so this session is
    byte-for-byte "no agent running" unless `observation_degraded` is read.
    """
    return TmuxSessionInfo(
        name=name,
        path=str(path),
        created_at=datetime(2026, 8, 9, 11, 0, tzinfo=timezone.utc),
        windows=1,
        attached=False,
        current_command=None,
        is_codex_running=False,
        is_claude_code_running=False,
        observation_degraded=True,
    )


@pytest.mark.asyncio
async def test_retry_is_refused_when_the_session_could_not_be_inspected(
    client, tmp_path, monkeypatch
):
    """A degraded probe observed nothing, so it cannot clear a session.

    Dispatching anyway types a launch command into whatever holds the pane,
    and `start_claude`'s readiness check can then confirm against a
    PRE-EXISTING agent -- producing a `dispatched` run with no DOLPHIN_RUN_ID
    in anyone's environment. Nothing can ever close that run: the hook cannot
    fire, and reconciliation will not abandon it while the session is live.
    That is the exact defect class this feature exists to remove.
    """
    http_client, sessions = client
    workspace = tmp_path / "projects" / "dolphin"
    workspace.mkdir(parents=True)
    monkeypatch.setenv("DOLPHIN_WORKSPACE_ROOTS", str(tmp_path / "projects"))
    await _seed_dispatched_task(sessions, workspace.resolve(), workflow_state="review")

    async with sessions() as db:
        old = await run_service.create_run(
            db, task_id="task-1", project_id="proj-1",
            session_name=SESSION_NAME, agent="claude",
            workspace_path=str(workspace.resolve()),
        )
        await run_service.transition(db, old, "awaiting_receipt")
        old_id = old.id

    started: list[tuple] = []

    async def fake_require(path, name):
        return _degraded_session(name, path)

    async def fake_start_claude(path, name, initial_prompt=None, run_id=None):
        # Recorded rather than raising, so a regression fails as "200, and an
        # agent was started" instead of as an opaque 500.
        started.append((path, name, initial_prompt, run_id))

    async def unexpected_send(*_args, **_kwargs):
        raise AssertionError("An uninspectable session must not be typed into")

    monkeypatch.setattr(tmux_service, "require_workspace_session", fake_require)
    monkeypatch.setattr(tmux_service, "start_claude", fake_start_claude)
    monkeypatch.setattr(tmux_service, "send_input", unexpected_send)

    response = await http_client.post(f"/api/runs/{old_id}/retry")
    assert response.status_code == 409, response.json()
    assert started == [], "nothing may be dispatched into an uninspected session"

    async with sessions() as db:
        workflow = await db.get(TaskWorkflow, "task-1")
        assert workflow.state == "review"
        assert workflow.research_status == "researching"
        assert len(await run_service.list_runs(db)) == 1
        assert (await run_service.get_run(db, old_id)).state == "awaiting_receipt"

    detail = response.json()["detail"]
    assert "could not inspect" in detail
    # It must not invent the opposite certainty either: nothing observed an
    # agent here.
    assert "still running" not in detail
