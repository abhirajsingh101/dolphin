"""Durable agent-run lifecycle.

Every transition here needs an observable trigger. The one inference this
module refuses to make is the one Phase B exists to remove: that a live agent
process means the work is finished. Only the receipt gate closes a run.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from . import receipts
from .models import Project, Run, Task, generate_run_id


RUN_STATES = frozenset({
    "dispatched", "running", "awaiting_receipt", "needs_review",
    "approved", "dismissed", "failed", "abandoned",
})

TERMINAL_RUN_STATES = frozenset({"approved", "dismissed", "failed", "abandoned"})

# `running` is skippable: a turn can end before the periodic probe runs.
_ALLOWED: dict[str, frozenset[str]] = {
    "dispatched": frozenset({"running", "awaiting_receipt", "needs_review", "failed", "abandoned"}),
    "running": frozenset({"awaiting_receipt", "needs_review", "failed", "abandoned"}),
    "awaiting_receipt": frozenset({"needs_review", "approved", "dismissed", "failed", "abandoned"}),
    "needs_review": frozenset({"approved", "dismissed", "failed", "abandoned"}),
}

RECONCILE_GRACE = timedelta(seconds=60)


class IllegalRunTransition(Exception):
    """Raised instead of silently writing a state that was never observed."""


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def create_run(
    db: AsyncSession,
    *,
    task_id: str,
    project_id: str,
    session_name: str,
    agent: str,
    workspace_path: str,
) -> Run:
    run = Run(
        id=generate_run_id(),
        task_id=task_id,
        project_id=project_id,
        session_name=session_name,
        agent=agent,
        workspace_path=workspace_path,
        state="dispatched",
        dispatched_at=_now(),
    )
    db.add(run)
    await db.commit()
    return run


async def transition(
    db: AsyncSession, run: Run, to_state: str, *, error: str | None = None
) -> Run:
    if to_state not in RUN_STATES:
        raise IllegalRunTransition(f"{to_state!r} is not a run state")
    allowed = _ALLOWED.get(run.state, frozenset())
    if to_state not in allowed:
        raise IllegalRunTransition(
            f"run {run.id} cannot move {run.state!r} -> {to_state!r}"
        )

    run.state = to_state
    now = _now()
    run.updated_at = now
    if to_state == "running" and run.started_at is None:
        run.started_at = now
    if to_state in {"awaiting_receipt", "needs_review"} or to_state in TERMINAL_RUN_STATES:
        run.ended_at = run.ended_at or now
    if error is not None:
        run.error = error
    await db.commit()
    return run


async def get_run(db: AsyncSession, run_id: str) -> Run | None:
    result = await db.execute(select(Run).where(Run.id == run_id))
    return result.scalar_one_or_none()


async def list_runs(db: AsyncSession, states: set[str] | None = None) -> list[Run]:
    query = select(Run).order_by(Run.dispatched_at.desc(), Run.id)
    if states:
        query = query.where(Run.state.in_(states))
    result = await db.execute(query)
    return list(result.scalars().all())


async def list_runs_with_context(
    db: AsyncSession, states: set[str] | None = None
) -> list[tuple[Run, str, str]]:
    """Runs with the task title and project name a queue row must show.

    An INNER join on both: `runs.task_id` is ON DELETE CASCADE, so a run
    cannot outlive its task in production and this excludes nothing real. A
    row with no title is not a row a human can act on, so an outer join would
    only buy a `None` the surface would have to invent copy for.

    Joined on `Run.project_id`, not `Task.project_id`: they differ when a task
    was placed into a temporary workspace, and the queue groups by where the
    run actually happened.
    """
    query = (
        select(Run, Task.title, Project.name)
        .join(Task, Task.id == Run.task_id)
        .join(Project, Project.id == Run.project_id)
        .order_by(Run.dispatched_at.desc(), Run.id)
    )
    if states:
        query = query.where(Run.state.in_(states))
    result = await db.execute(query)
    return [(row[0], row[1], row[2]) for row in result.all()]


_RECEIPT_INSTRUCTION = (
    "This run is not finished until its receipt exists. Write a short markdown "
    "summary to {path} covering: what changed, which files, how to verify it, "
    "and anything left unfinished. Then stop."
)


async def record_turn_end(db: AsyncSession, run: Run) -> tuple[Run, bool, str]:
    """Apply the receipt gate to a turn that just ended.

    Returns (run, block, reason). The DECISION is made here rather than in the
    hook, so changing policy never requires re-installing anything in the
    operator's global config (spec §6.2).

    A turn ending is a real observed event even when the run is already in
    the state this turn would move it to (e.g. a second turn still finds no
    receipt). `_ALLOWED` deliberately has no self-transitions, so calling
    `transition()` with `to_state == run.state` would raise
    `IllegalRunTransition` for an event that is entirely legitimate. So
    `transition()` is only called when the target state differs from the
    run's current state; a same-state repeat still bumps `turn_count` and
    `last_event_at` and commits directly, without touching `run.state`.

    A run already at `needs_review` is handled before any of that: its
    receipt was observed present at least once, and `needs_review` has no
    legal transition back to `awaiting_receipt` (approval/dismissal are the
    only ways out). If the receipt file later disappears -- `git clean`, a
    cleared `.dolphin/`, anything -- re-checking disk here would either raise
    `IllegalRunTransition` (an uncaught 500) or, if that guard were loosened,
    silently downgrade a run that already earned review back to blocking on a
    receipt that already did its job once. Both are the same defect this
    module exists to remove, just aimed at a success instead of a failure. So
    a turn ending on an already-`needs_review` run is recorded as activity
    only: it never re-reads the receipt and never asks the agent to block.
    """
    run.turn_count = (run.turn_count or 0) + 1
    run.last_event_at = _now()

    if run.state == "needs_review":
        run.updated_at = _now()
        await db.commit()
        return (run, False, "")

    exists, _text, _truncated = receipts.read_receipt(run.workspace_path, run.id)
    if exists:
        run.receipt_path = str(receipts.receipt_path(run.workspace_path, run.id))
        to_state = "needs_review"
    else:
        to_state = "awaiting_receipt"

    if to_state != run.state:
        await transition(db, run, to_state)
    else:
        run.updated_at = _now()
        await db.commit()

    if exists:
        return (run, False, "")

    reason = _RECEIPT_INSTRUCTION.format(
        path=receipts.receipt_path(run.workspace_path, run.id)
    )
    return (run, True, reason)



# Retry, rebuilt for Stage 4. The first version wrote a fresh `dispatched`
# row and dispatched nothing -- no tmux send, no DOLPHIN_RUN_ID, no
# prepare_workspace -- so nothing could ever close it: the hook can only fire
# inside an agent process that was never started, and reconciliation never
# abandons it because the copied session name is still live. It was removed
# rather than half-fixed. This version does not create the run at all: it
# re-enters task_workflow_service.launch_task_research, which owns the
# Task/TaskWorkflow context a real dispatch needs and writes the run itself.
RETRYABLE_RUN_STATES = frozenset({
    "awaiting_receipt", "needs_review", "failed", "abandoned", "dismissed",
})


async def latest_run_for_task(db: AsyncSession, task_id: str) -> Run | None:
    result = await db.execute(
        select(Run)
        .where(Run.task_id == task_id)
        .order_by(Run.dispatched_at.desc(), Run.id.desc())
        .limit(1)
    )
    return result.scalar_one_or_none()


async def latest_runs_by_task(db: AsyncSession) -> dict[str, Run]:
    """Exactly one row per task -- its newest run, whatever state it is in.

    A window function rather than loading every run and reducing in Python:
    this is bounded by task count, which the snapshot is already bounded by,
    while `SELECT * FROM runs` grows with history forever.

    Deliberately not shared with reconcile_runs' query even though both read
    `runs`. Reconciliation needs EVERY open run -- an old awaiting_receipt row
    is not necessarily the latest for its task -- and this needs exactly one
    per task including terminal ones. The single query serving both is the
    unbounded one. Two flat queries, budget 5. See the design §4.6.
    """
    ranked = select(
        Run,
        func.row_number()
        .over(
            partition_by=Run.task_id,
            order_by=(Run.dispatched_at.desc(), Run.id.desc()),
        )
        .label("rank"),
    ).subquery()
    newest = aliased(Run, ranked)
    result = await db.execute(select(newest).where(ranked.c.rank == 1))
    return {run.task_id: run for run in result.scalars().all()}


# Reconciliation only ever touches runs still open for it to observe:
# `dispatched`, `running`, `awaiting_receipt`. `needs_review` is deliberately
# excluded -- its receipt already exists on disk, so tmux session liveness is
# irrelevant to it, and the existing Done path routinely kills sessions right
# after a run reaches `needs_review`. Sweeping it here would rewrite a
# success as a failure (CRITICAL 3): `error="tmux session is gone"` on a run
# a human has evidence to approve.
_RECONCILABLE_STATES = frozenset({"dispatched", "running", "awaiting_receipt"})


async def reconcile_runs(
    db: AsyncSession,
    live_session_names: set[str],
    *,
    now: datetime | None = None,
    running_sessions_by_agent: dict[str, set[str]] | None = None,
) -> int:
    """Promote observed-alive dispatches and abandon runs whose session is gone.

    Both actions ride the single `list_runs` query below so this stays one
    fixed `SELECT ... FROM runs` regardless of how many runs are open (the
    frozen query budget in `test_database_query_count_is_bounded...`).

    Promotion (`dispatched` -> `running`, spec §4): `running_sessions_by_agent`
    maps an agent name ('claude' | 'codex') to the session names where that
    agent's process is currently observed alive -- a fact the control-center
    snapshot already gathers via the process-tree probe. Observing a process
    is legitimate; the one inference this module refuses is that a live
    process means the work is *finished*. Only the receipt gate closes a run.

    Abandonment: deterministic observation, not inference -- the session
    either exists or it does not. The grace period exists because a session
    is briefly absent while being created, and without it a healthy dispatch
    is abandoned at birth.
    """
    moment = now or _now()
    running_sessions_by_agent = running_sessions_by_agent or {}
    open_runs = await list_runs(db, set(_RECONCILABLE_STATES))
    changed = 0
    for run in open_runs:
        if run.state == "dispatched":
            live_for_agent = running_sessions_by_agent.get(run.agent, set())
            if run.session_name in live_for_agent:
                await transition(db, run, "running")
                changed += 1

        if run.session_name in live_session_names:
            continue
        marker = run.last_event_at or run.dispatched_at
        if marker is not None and marker.tzinfo is None:
            # SQLite returns naive datetimes; every value this module writes
            # is UTC (`_now()`), so a naive read is UTC without a label.
            marker = marker.replace(tzinfo=timezone.utc)
        if marker is not None and moment - marker < RECONCILE_GRACE:
            continue
        await transition(db, run, "abandoned", error="tmux session is gone")
        changed += 1
    return changed
