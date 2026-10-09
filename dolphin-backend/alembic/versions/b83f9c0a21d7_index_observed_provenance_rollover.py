"""index bounded observed provenance rollover queries

Revision ID: b83f9c0a21d7
Revises: a7d3e9c51b20
Create Date: 2026-09-08 04:00:00

"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "b83f9c0a21d7"
down_revision: Union[str, Sequence[str], None] = "a7d3e9c51b20"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

INDEX_NAME = "ix_task_planning_events_proposal_actor_created"
SEQUENCE_INDEX_NAME = "ix_task_planning_events_proposal_sequence"
SEQUENCE_COLUMN = "provenance_sequence"


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if "task_planning_events" not in inspector.get_table_names():
        return
    indexes = {
        item["name"] for item in inspector.get_indexes("task_planning_events")
    }
    columns = {item["name"] for item in inspector.get_columns("task_planning_events")}
    if SEQUENCE_COLUMN not in columns:
        op.add_column(
            "task_planning_events",
            sa.Column(SEQUENCE_COLUMN, sa.Integer(), nullable=True),
        )
    # This block intentionally runs even when the column already exists. An
    # interrupted SQLite migration may have committed the additive DDL before
    # all rows were backfilled, and a restart must finish deterministically.
    bind = op.get_bind()
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
    for event_id, proposal_id, stored_sequence in rows:
        grouped.setdefault(proposal_id, []).append((event_id, stored_sequence))
    for proposal_rows in grouped.values():
        row_count = len(proposal_rows)
        retained: set[int] = set()
        missing_event_ids: list[str] = []
        for event_id, stored_sequence in proposal_rows:
            if stored_sequence is None:
                missing_event_ids.append(event_id)
                continue
            sequence = int(stored_sequence)
            if sequence < 1 or sequence > row_count or sequence in retained:
                raise RuntimeError("observed provenance sequence is unsafe")
            retained.add(sequence)
        missing_sequences = [
            sequence for sequence in range(1, row_count + 1) if sequence not in retained
        ]
        if len(missing_event_ids) != len(missing_sequences):
            raise RuntimeError("observed provenance sequence is unsafe")
        # Existing unique per-proposal order is authoritative even if the wall
        # clock moved backwards. Only nulls are placed deterministically into
        # the unused slots, in the stable legacy created_at/id order above.
        for event_id, sequence in zip(missing_event_ids, missing_sequences):
            bind.execute(
                sa.text(
                    "UPDATE task_planning_events "
                    "SET provenance_sequence = :sequence WHERE id = :event_id"
                ),
                {"sequence": sequence, "event_id": event_id},
            )
    if INDEX_NAME not in indexes:
        op.create_index(
            INDEX_NAME,
            "task_planning_events",
            ["proposal_id", "actor", "created_at", "id"],
            unique=False,
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
        != ("proposal_id", SEQUENCE_COLUMN)
    ):
        op.drop_index(SEQUENCE_INDEX_NAME, table_name="task_planning_events")
        sequence_index = None
    if sequence_index is None:
        op.create_index(
            SEQUENCE_INDEX_NAME,
            "task_planning_events",
            ["proposal_id", SEQUENCE_COLUMN],
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
        != ("proposal_id", SEQUENCE_COLUMN)
    ):
        raise RuntimeError("observed provenance sequence index is invalid")


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if "task_planning_events" not in inspector.get_table_names():
        return
    indexes = {
        item["name"] for item in inspector.get_indexes("task_planning_events")
    }
    if SEQUENCE_INDEX_NAME in indexes:
        op.drop_index(SEQUENCE_INDEX_NAME, table_name="task_planning_events")
    columns = {item["name"] for item in inspector.get_columns("task_planning_events")}
    if SEQUENCE_COLUMN in columns:
        op.drop_column("task_planning_events", SEQUENCE_COLUMN)
    if INDEX_NAME in indexes:
        op.drop_index(INDEX_NAME, table_name="task_planning_events")
