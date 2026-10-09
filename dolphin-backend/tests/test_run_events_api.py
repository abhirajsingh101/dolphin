"""HTTP-level guards for POST /api/runs/{run_id}/events (Task 4).

The lifespan protocol is deliberately never entered here. `app.main`'s
startup event snapshots and migrates the *real* database
(`dolphin_tasks.db`) as a side effect of importing the app -- appropriate for
the running backend, unacceptable for a test suite. httpx's `ASGITransport`
only ever delivers HTTP scopes to the app, never a `lifespan` scope, so
`@app.on_event("startup")` never fires and the dependency override below is
the only database the app sees for these tests.
"""

from __future__ import annotations

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.database import Base, get_db
from app.main import app
from app import run_service


@pytest_asyncio.fixture
async def client(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'events.db'}")
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
async def test_unknown_run_is_404(client):
    http_client, _sessions = client
    response = await http_client.post(
        "/api/runs/does-not-exist/events", json={"type": "turn_end"}
    )
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_turn_end_without_receipt_blocks_with_actionable_reason(client, tmp_path):
    http_client, sessions = client
    async with sessions() as db:
        run = await run_service.create_run(
            db, task_id="t1", project_id="p1",
            session_name="s1", agent="claude", workspace_path=str(tmp_path),
        )
        run_id = run.id

    response = await http_client.post(
        f"/api/runs/{run_id}/events", json={"type": "turn_end"}
    )
    assert response.status_code == 200
    body = response.json()
    assert body["block"] is True
    assert ".dolphin/runs/" in body["reason"] and "receipt.md" in body["reason"]

    async with sessions() as db:
        stored = await run_service.get_run(db, run_id)
        assert stored.state == "awaiting_receipt"
        assert stored.turn_count == 1


@pytest.mark.asyncio
async def test_failed_event_transitions_and_stores_error(client, tmp_path):
    http_client, sessions = client
    async with sessions() as db:
        run = await run_service.create_run(
            db, task_id="t1", project_id="p1",
            session_name="s1", agent="claude", workspace_path=str(tmp_path),
        )
        run_id = run.id

    response = await http_client.post(
        f"/api/runs/{run_id}/events",
        json={"type": "failed", "message": "agent crashed"},
    )
    assert response.status_code == 200
    assert response.json() == {"block": False, "reason": ""}

    async with sessions() as db:
        stored = await run_service.get_run(db, run_id)
        assert stored.state == "failed"
        assert stored.error == "agent crashed"


@pytest.mark.asyncio
async def test_terminal_run_ignores_replayed_events(client, tmp_path):
    """A late hook call after approval must be harmless, not resurrect the run."""
    http_client, sessions = client
    async with sessions() as db:
        run = await run_service.create_run(
            db, task_id="t1", project_id="p1",
            session_name="s1", agent="claude", workspace_path=str(tmp_path),
        )
        run_id = run.id
        await run_service.transition(db, run, "needs_review")
        await run_service.transition(db, run, "approved")

    response = await http_client.post(
        f"/api/runs/{run_id}/events", json={"type": "turn_end"}
    )
    assert response.status_code == 200
    assert response.json() == {"block": False, "reason": ""}

    async with sessions() as db:
        stored = await run_service.get_run(db, run_id)
        # Ignored, not resurrected: state and turn_count are untouched.
        assert stored.state == "approved"
        assert stored.turn_count == 0


@pytest.mark.asyncio
async def test_approve_on_a_dispatched_run_is_409_not_500(client, tmp_path):
    """The endpoint must translate IllegalRunTransition into a 409, not let
    it surface as an unhandled 500."""
    http_client, sessions = client
    async with sessions() as db:
        run = await run_service.create_run(
            db, task_id="t1", project_id="p1",
            session_name="s1", agent="claude", workspace_path=str(tmp_path),
        )
        run_id = run.id

    response = await http_client.post(f"/api/runs/{run_id}/approve")
    assert response.status_code == 409
    assert "cannot move" in response.json()["detail"]


@pytest.mark.asyncio
async def test_dismiss_on_a_dispatched_run_is_409_not_500(client, tmp_path):
    http_client, sessions = client
    async with sessions() as db:
        run = await run_service.create_run(
            db, task_id="t1", project_id="p1",
            session_name="s1", agent="claude", workspace_path=str(tmp_path),
        )
        run_id = run.id

    response = await http_client.post(f"/api/runs/{run_id}/dismiss")
    assert response.status_code == 409
    assert "cannot move" in response.json()["detail"]


@pytest.mark.asyncio
async def test_retry_on_a_dispatched_run_is_409_not_500(client, tmp_path):
    """Retry was rebuilt in Stage 4 (see app/run_service.py's comment at
    `RETRYABLE_RUN_STATES`). `dispatched` is not retryable -- that run is
    live and retrying would double-dispatch into its session -- so this must
    stay a 409 from the state guard, never reach `launch_task_research`, and
    never touch tmux.
    """
    http_client, sessions = client
    async with sessions() as db:
        run = await run_service.create_run(
            db, task_id="t1", project_id="p1",
            session_name="s1", agent="claude", workspace_path=str(tmp_path),
        )
        run_id = run.id

    response = await http_client.post(f"/api/runs/{run_id}/retry")
    assert response.status_code == 409

    async with sessions() as db:
        # No second run was created -- the queue did not grow.
        assert len(await run_service.list_runs(db)) == 1


@pytest.mark.asyncio
async def test_second_turn_end_after_needs_review_is_200_not_500(client, tmp_path):
    """IMPORTANT 4. `needs_review` is non-terminal, so a second `turn_end`
    reaches `record_turn_end` rather than the terminal-run short-circuit.
    Before the fix, a receipt that disappeared after `needs_review` (e.g.
    `git clean`) made `record_turn_end` try `needs_review -> awaiting_receipt`,
    which `_ALLOWED` refuses -- `IllegalRunTransition`, uncaught, HTTP 500.
    """
    from app import receipts

    http_client, sessions = client
    async with sessions() as db:
        run = await run_service.create_run(
            db, task_id="t1", project_id="p1",
            session_name="s1", agent="claude", workspace_path=str(tmp_path),
        )
        run_id = run.id
        path = receipts.receipt_path(str(tmp_path), run_id)
        path.parent.mkdir(parents=True)
        path.write_text("# Done\n")

    first = await http_client.post(
        f"/api/runs/{run_id}/events", json={"type": "turn_end"}
    )
    assert first.status_code == 200
    assert first.json() == {"block": False, "reason": ""}

    path.unlink()  # The receipt is gone before the next turn ends.

    second = await http_client.post(
        f"/api/runs/{run_id}/events", json={"type": "turn_end"}
    )
    assert second.status_code == 200
    assert second.json() == {"block": False, "reason": ""}

    async with sessions() as db:
        stored = await run_service.get_run(db, run_id)
        assert stored.state == "needs_review"
        assert stored.turn_count == 2
