"""harden observed release and logical-agent epochs

Revision ID: c1a9d4e72f06
Revises: b83f9c0a21d7
Create Date: 2026-09-08 08:00:00

"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "c1a9d4e72f06"
down_revision: Union[str, Sequence[str], None] = "b83f9c0a21d7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

SEQUENCE_INDEX_NAME = "ix_task_planning_events_proposal_sequence"
EPOCH_COLUMNS = (
    "interaction_epoch",
    "last_human_input_epoch",
    "last_provider_hook_epoch",
)


def _repair_and_verify_observed_sequences() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "task_planning_events" not in inspector.get_table_names():
        return
    columns = {item["name"] for item in inspector.get_columns("task_planning_events")}
    if "provenance_sequence" not in columns:
        op.add_column(
            "task_planning_events",
            sa.Column("provenance_sequence", sa.Integer(), nullable=True),
        )
    rows = bind.execute(
        sa.text(
            "SELECT id, proposal_id, provenance_sequence "
            "FROM task_planning_events "
            "WHERE proposal_id IS NOT NULL "
            "AND actor IN ('system:observed-work', "
            "'system:observed-work:summary') "
            "ORDER BY proposal_id, created_at, id"
        )
    ).fetchall()
    grouped: dict[str, list[tuple[str, int | None]]] = {}
    for event_id, proposal_id, stored in rows:
        grouped.setdefault(proposal_id, []).append((event_id, stored))
    for proposal_rows in grouped.values():
        row_count = len(proposal_rows)
        retained: set[int] = set()
        missing_event_ids: list[str] = []
        for event_id, stored in proposal_rows:
            if stored is None:
                missing_event_ids.append(event_id)
                continue
            sequence = int(stored)
            if sequence < 1 or sequence > row_count or sequence in retained:
                raise RuntimeError("observed provenance sequence is unsafe")
            retained.add(sequence)
        missing_sequences = [
            sequence for sequence in range(1, row_count + 1) if sequence not in retained
        ]
        if len(missing_event_ids) != len(missing_sequences):
            raise RuntimeError("observed provenance sequence is unsafe")
        for event_id, sequence in zip(missing_event_ids, missing_sequences):
            bind.execute(
                sa.text(
                    "UPDATE task_planning_events SET provenance_sequence = :sequence "
                    "WHERE id = :event_id"
                ),
                {"sequence": sequence, "event_id": event_id},
            )
    sequence_index = next(
        (
            item
            for item in sa.inspect(bind).get_indexes("task_planning_events")
            if item["name"] == SEQUENCE_INDEX_NAME
        ),
        None,
    )
    if sequence_index is not None and (
        not sequence_index.get("unique")
        or tuple(sequence_index.get("column_names") or ())
        != ("proposal_id", "provenance_sequence")
    ):
        op.drop_index(SEQUENCE_INDEX_NAME, table_name="task_planning_events")
        sequence_index = None
    if sequence_index is None:
        op.create_index(
            SEQUENCE_INDEX_NAME,
            "task_planning_events",
            ["proposal_id", "provenance_sequence"],
            unique=True,
        )
    verified_sequence_index = next(
        (
            item
            for item in sa.inspect(bind).get_indexes("task_planning_events")
            if item["name"] == SEQUENCE_INDEX_NAME
        ),
        None,
    )
    if (
        verified_sequence_index is None
        or not verified_sequence_index.get("unique")
        or tuple(verified_sequence_index.get("column_names") or ())
        != ("proposal_id", "provenance_sequence")
    ):
        raise RuntimeError("observed provenance sequence index is invalid")
    missing = bind.execute(
        sa.text(
            "SELECT count(*) FROM task_planning_events "
            "WHERE proposal_id IS NOT NULL "
            "AND actor IN ('system:observed-work', "
            "'system:observed-work:summary') "
            "AND provenance_sequence IS NULL"
        )
    ).scalar_one()
    if int(missing):
        raise RuntimeError("observed provenance sequence backfill is incomplete")


def upgrade() -> None:
    _repair_and_verify_observed_sequences()
    inspector = sa.inspect(op.get_bind())
    if "session_automations" not in inspector.get_table_names():
        return
    columns = {item["name"] for item in inspector.get_columns("session_automations")}
    for name in EPOCH_COLUMNS:
        if name not in columns:
            op.add_column(
                "session_automations",
                sa.Column(name, sa.Integer(), server_default=sa.text("0"), nullable=False),
            )
    for name in ("last_provider_hook_provider", "last_provider_hook_agent_session_id"):
        if name not in columns:
            op.add_column(
                "session_automations",
                sa.Column(name, sa.String(), nullable=True),
            )


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if "session_automations" not in inspector.get_table_names():
        return
    columns = {item["name"] for item in inspector.get_columns("session_automations")}
    for name in (
        "last_provider_hook_agent_session_id",
        "last_provider_hook_provider",
        *reversed(EPOCH_COLUMNS),
    ):
        if name in columns:
            op.drop_column("session_automations", name)
