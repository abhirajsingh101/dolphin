"""Run lifecycle: one row per dispatch, append-only, transitions observable."""

from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.database import Base
from app.models import Run, generate_run_id
from app import run_service
from app.run_service import IllegalRunTransition


# `pytest_asyncio.fixture`, NOT `pytest.fixture`. This project has no
# asyncio_mode setting, so pytest-asyncio 1.3 runs in strict mode, where a
# plain @pytest.fixture on an async generator hands the test the generator
# object instead of a session — every assertion then fails on an AttributeError
# that looks nothing like the real cause.
@pytest_asyncio.fixture
async def run_db(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'runs.db'}")
    sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    try:
        async with sessions() as db:
            yield db
    finally:
        await engine.dispose()


@pytest_asyncio.fixture
async def second_session(run_db, tmp_path):
    """A genuinely separate session against the SAME database file as `run_db`.

    `run_db` uses `expire_on_commit=False`, so within a single test every read
    through it returns the identity-mapped Python object already in memory --
    a `dispatched_at` assigned as an aware `datetime` never actually leaves
    the process, let alone round-trips through SQLite's naive storage. That
    hides the exact bug `reconcile_runs`'s tzinfo fix-up exists to prevent.
    Production reads through a fresh session per request (`get_db`), so this
    fixture opens a second engine/session on the same file to force a real
    round trip: rows this fixture reads back were written by `run_db` and
    come back with `tzinfo=None`, exactly as aiosqlite hands them to a fresh
    request.
    """
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'runs.db'}")
    sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    try:
        async with sessions() as db:
            yield db
    finally:
        await engine.dispose()


def test_generate_run_id_is_unguessable_and_unique():
    ids = {generate_run_id() for _ in range(100)}
    assert len(ids) == 100
    # secrets.token_urlsafe(24) yields 32 url-safe chars; guard the floor so a
    # future change cannot quietly shorten an id that appears in a callback URL.
    assert all(len(i) >= 32 for i in ids)


def test_run_column_defaults_are_declared():
    # Asserted on the table rather than a transient instance: SQLAlchemy
    # applies column defaults at flush, so a bare Run() has None here and
    # testing the instance would only prove that.
    assert Run.__table__.c.state.default.arg == "dispatched"
    assert Run.__table__.c.turn_count.default.arg == 0
    assert Run.__table__.c.receipt_path.nullable is True


@pytest.mark.asyncio
async def test_create_run_starts_dispatched(run_db):
    run = await run_service.create_run(
        run_db, task_id="t1", project_id="p1",
        session_name="s1", agent="claude", workspace_path="/tmp/w",
    )
    assert run.state == "dispatched"
    assert run.dispatched_at is not None


@pytest.mark.asyncio
async def test_legal_transitions_are_allowed(run_db):
    run = await run_service.create_run(
        run_db, task_id="t1", project_id="p1",
        session_name="s1", agent="claude", workspace_path="/tmp/w",
    )
    await run_service.transition(run_db, run, "running")
    assert run.started_at is not None
    await run_service.transition(run_db, run, "needs_review")
    assert run.ended_at is not None
    await run_service.transition(run_db, run, "approved")
    assert run.state == "approved"


@pytest.mark.asyncio
async def test_illegal_transition_is_refused(run_db):
    run = await run_service.create_run(
        run_db, task_id="t1", project_id="p1",
        session_name="s1", agent="claude", workspace_path="/tmp/w",
    )
    with pytest.raises(IllegalRunTransition):
        # A run cannot be approved before anything observed it end.
        await run_service.transition(run_db, run, "approved")


@pytest.mark.asyncio
async def test_terminal_runs_refuse_further_transitions(run_db):
    run = await run_service.create_run(
        run_db, task_id="t1", project_id="p1",
        session_name="s1", agent="claude", workspace_path="/tmp/w",
    )
    await run_service.transition(run_db, run, "needs_review")
    await run_service.transition(run_db, run, "approved")
    # A replayed hook event must not resurrect a closed run (spec §4).
    with pytest.raises(IllegalRunTransition):
        await run_service.transition(run_db, run, "running")


@pytest.mark.asyncio
async def test_running_may_be_skipped(run_db):
    # A turn can end before the periodic process probe runs (spec §4).
    run = await run_service.create_run(
        run_db, task_id="t1", project_id="p1",
        session_name="s1", agent="claude", workspace_path="/tmp/w",
    )
    await run_service.transition(run_db, run, "awaiting_receipt")
    assert run.state == "awaiting_receipt"


@pytest.mark.asyncio
async def test_turn_end_with_a_receipt_needs_review(run_db, tmp_path):
    from app import receipts

    run = await run_service.create_run(
        run_db, task_id="t1", project_id="p1",
        session_name="s1", agent="claude", workspace_path=str(tmp_path),
    )
    path = receipts.receipt_path(str(tmp_path), run.id)
    path.parent.mkdir(parents=True)
    path.write_text("# Done\n")

    run, block, reason = await run_service.record_turn_end(run_db, run)

    assert run.state == "needs_review"
    assert run.receipt_path == str(path)
    assert block is False
    assert reason == ""


@pytest.mark.asyncio
async def test_turn_end_without_a_receipt_blocks_and_names_the_path(run_db, tmp_path):
    run = await run_service.create_run(
        run_db, task_id="t1", project_id="p1",
        session_name="s1", agent="claude", workspace_path=str(tmp_path),
    )

    run, block, reason = await run_service.record_turn_end(run_db, run)

    assert run.state == "awaiting_receipt"
    assert block is True
    # The reason must be actionable: it names the exact file to write.
    assert ".dolphin/runs/" in reason and "receipt.md" in reason


@pytest.mark.asyncio
async def test_turn_end_counts_turns(run_db, tmp_path):
    run = await run_service.create_run(
        run_db, task_id="t1", project_id="p1",
        session_name="s1", agent="claude", workspace_path=str(tmp_path),
    )
    await run_service.record_turn_end(run_db, run)
    await run_service.record_turn_end(run_db, run)
    assert run.turn_count == 2


@pytest.mark.asyncio
async def test_turn_end_after_needs_review_does_not_resurrect_awaiting_receipt(
    run_db, tmp_path
):
    """IMPORTANT 4. A second turn ending after the receipt already earned
    `needs_review` must never raise, and must never revert the run to
    `awaiting_receipt` just because the receipt file is gone by the time this
    turn is checked (e.g. `git clean`, a cleared `.dolphin/`). `needs_review`
    has no legal transition back to `awaiting_receipt` -- before this fix,
    `record_turn_end` would call `transition()` anyway and raise
    `IllegalRunTransition`, which the events endpoint did not catch.
    """
    from app import receipts

    run = await run_service.create_run(
        run_db, task_id="t1", project_id="p1",
        session_name="s1", agent="claude", workspace_path=str(tmp_path),
    )
    path = receipts.receipt_path(str(tmp_path), run.id)
    path.parent.mkdir(parents=True)
    path.write_text("# Done\n")

    run, block, _reason = await run_service.record_turn_end(run_db, run)
    assert run.state == "needs_review"
    assert block is False

    path.unlink()  # The receipt is gone by the time the next turn ends.

    run, block, reason = await run_service.record_turn_end(run_db, run)

    assert run.state == "needs_review"
    assert block is False
    assert reason == ""
    assert run.turn_count == 2


@pytest.mark.asyncio
async def test_reconcile_never_downgrades_a_needs_review_run_to_abandoned(
    run_db, tmp_path
):
    """CRITICAL 3. A `needs_review` run already has a receipt on disk; the
    existing Done path routinely kills its session right after. Sweeping
    `needs_review` into `reconcile_runs`'s open set would rewrite that
    success as `abandoned, error="tmux session is gone"` -- recording a
    success as a failure, the reverse of the phantom-run defect but the same
    class of error.
    """
    run = await run_service.create_run(
        run_db, task_id="t1", project_id="p1",
        session_name="reviewed", agent="claude", workspace_path=str(tmp_path),
    )
    await run_service.transition(run_db, run, "needs_review")
    run.last_event_at = datetime.now(timezone.utc) - timedelta(seconds=120)
    await run_db.commit()

    changed = await run_service.reconcile_runs(run_db, live_session_names=set())

    assert changed == 0
    assert run.state == "needs_review"


@pytest.mark.asyncio
async def test_reconcile_promotes_dispatched_to_running_when_the_process_is_alive(
    run_db, tmp_path
):
    """IMPORTANT 5. Spec §4: `-> running` fires when the dispatched agent's
    process is observed alive in its session. `running_sessions_by_agent`
    carries that observation from the process-tree probe the control-center
    snapshot already gathers, keyed by the run's own agent -- a codex process
    in a session must not promote a `claude` run, and vice versa.
    """
    tracked = await run_service.create_run(
        run_db, task_id="t1", project_id="p1",
        session_name="live-claude", agent="claude", workspace_path=str(tmp_path),
    )
    wrong_agent = await run_service.create_run(
        run_db, task_id="t2", project_id="p1",
        session_name="live-codex", agent="claude", workspace_path=str(tmp_path),
    )
    assert tracked.started_at is None

    changed = await run_service.reconcile_runs(
        run_db,
        live_session_names={"live-claude", "live-codex"},
        running_sessions_by_agent={
            "claude": {"live-claude"},
            "codex": {"live-codex"},
        },
    )

    assert changed == 1
    assert tracked.state == "running"
    assert tracked.started_at is not None
    # "live-codex" is running codex, not claude; wrong_agent (agent="claude")
    # must not be promoted on a codex process's say-so.
    assert wrong_agent.state == "dispatched"


@pytest.mark.asyncio
async def test_approving_a_run_does_not_touch_the_board(run_db, tmp_path):
    """Card movement is the operator's authority (spec §5).

    Approving evidence must never write TaskWorkflow.state. This is the test
    that catches a well-meaning future edit wiring the two together.
    """
    from app.models import Task, TaskWorkflow

    run_db.add(Task(id="t1", project_id="p1", title="Ship it"))
    run_db.add(TaskWorkflow(task_id="t1", state="in_progress"))
    await run_db.commit()

    run = await run_service.create_run(
        run_db, task_id="t1", project_id="p1",
        session_name="s1", agent="claude", workspace_path=str(tmp_path),
    )
    await run_service.transition(run_db, run, "needs_review")
    await run_service.transition(run_db, run, "approved")

    workflow = await run_db.get(TaskWorkflow, "t1")
    assert workflow.state == "in_progress"


# `retry_run` was removed (CRITICAL 2, Phase B fix review): it wrote a fresh
# `dispatched` row and dispatched nothing, so nothing could ever close it.
# See the comment above `_RECONCILABLE_STATES` in app/run_service.py and
# tests/test_run_events_api.py::test_retry_endpoint_no_longer_exists.
def test_retry_run_no_longer_exists():
    assert not hasattr(run_service, "retry_run")


def test_launch_command_carries_the_run_id():
    from app.tmux_service import build_agent_command

    # An untracked launch must be byte-identical to what shipped before, so
    # sessions the operator starts by hand are unaffected.
    plain = build_agent_command("claude", initial_prompt=None, run_id=None)
    assert plain == "claude"

    tracked = build_agent_command("claude", initial_prompt=None, run_id="RUN123")
    # The hook reads this from its environment; without it the hook is inert.
    assert tracked.startswith("DOLPHIN_RUN_ID=RUN123 ")
    assert tracked.endswith("claude")


@pytest.mark.asyncio
async def test_reconcile_abandons_a_run_whose_session_is_gone(run_db, tmp_path):
    run = await run_service.create_run(
        run_db, task_id="t1", project_id="p1",
        session_name="vanished", agent="claude", workspace_path=str(tmp_path),
    )
    run.dispatched_at = datetime.now(timezone.utc) - timedelta(seconds=120)
    await run_db.commit()

    changed = await run_service.reconcile_runs(run_db, live_session_names=set())

    assert changed == 1
    assert run.state == "abandoned"


@pytest.mark.asyncio
async def test_reconcile_respects_the_grace_period(run_db, tmp_path):
    # A session is briefly absent while being created; without the grace
    # period a healthy dispatch would be abandoned at birth (spec §8.3).
    run = await run_service.create_run(
        run_db, task_id="t1", project_id="p1",
        session_name="starting-up", agent="claude", workspace_path=str(tmp_path),
    )

    changed = await run_service.reconcile_runs(run_db, live_session_names=set())

    assert changed == 0
    assert run.state == "dispatched"


@pytest.mark.asyncio
async def test_reconcile_leaves_live_and_terminal_runs_alone(run_db, tmp_path):
    live = await run_service.create_run(
        run_db, task_id="t1", project_id="p1",
        session_name="alive", agent="claude", workspace_path=str(tmp_path),
    )
    live.dispatched_at = datetime.now(timezone.utc) - timedelta(seconds=120)
    closed = await run_service.create_run(
        run_db, task_id="t2", project_id="p1",
        session_name="gone", agent="claude", workspace_path=str(tmp_path),
    )
    closed.dispatched_at = datetime.now(timezone.utc) - timedelta(seconds=120)
    await run_service.transition(run_db, closed, "needs_review")
    await run_service.transition(run_db, closed, "approved")
    await run_db.commit()

    changed = await run_service.reconcile_runs(run_db, live_session_names={"alive"})

    assert changed == 0
    assert live.state == "dispatched"
    assert closed.state == "approved"


@pytest.mark.asyncio
async def test_reconcile_handles_naive_datetimes_from_a_fresh_session(
    run_db, second_session, tmp_path
):
    """Proves the tzinfo fix-up in `reconcile_runs` is load-bearing, not
    incidental. Every other reconcile test in this file drives everything
    through a single `run_db` session with `expire_on_commit=False`, so a
    `dispatched_at` assigned as an aware `datetime.now(timezone.utc)` is
    handed straight back on read from the session's identity map -- it never
    actually round-trips through SQLite's naive storage, and those tests
    would pass even if the fix-up were deleted.

    This test forces the real round trip: both runs are created and
    committed through `run_db`, then read and reconciled through
    `second_session`, a wholly separate session/engine on the same database
    file -- exactly how a fresh request-scoped session (`get_db`) sees a
    previously-committed row in production. One run sits inside the grace
    period and must survive; one sits past it and must be abandoned.
    """
    within_grace = await run_service.create_run(
        run_db, task_id="t1", project_id="p1",
        session_name="just-started", agent="claude", workspace_path=str(tmp_path),
    )
    within_grace.dispatched_at = datetime.now(timezone.utc) - timedelta(seconds=10)

    past_grace = await run_service.create_run(
        run_db, task_id="t2", project_id="p1",
        session_name="long-gone", agent="claude", workspace_path=str(tmp_path),
    )
    past_grace.dispatched_at = datetime.now(timezone.utc) - timedelta(seconds=120)
    await run_db.commit()

    # Read through the second, fresh session before reconciling: its identity
    # map is empty, so this is a genuine SELECT against the file, not a hit
    # on an in-memory object `run_db` already holds.
    reread_within = await second_session.get(Run, within_grace.id)
    reread_past = await second_session.get(Run, past_grace.id)
    assert reread_within.dispatched_at.tzinfo is None
    assert reread_past.dispatched_at.tzinfo is None

    changed = await run_service.reconcile_runs(second_session, live_session_names=set())

    assert changed == 1
    assert reread_within.state == "dispatched"
    assert reread_past.state == "abandoned"
