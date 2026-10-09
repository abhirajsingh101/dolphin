"""freeze the exact Active queue task scope

Revision ID: c4a8d2f901be
Revises: b7e1f3c42a90
Create Date: 2026-09-04 20:08:00

"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "c4a8d2f901be"
down_revision: Union[str, Sequence[str], None] = "b7e1f3c42a90"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _column_names() -> set[str]:
    inspector = sa.inspect(op.get_bind())
    if "session_automations" not in inspector.get_table_names():
        return set()
    return {
        column["name"]
        for column in inspector.get_columns("session_automations")
    }


def upgrade() -> None:
    if "active_task_fingerprint" not in _column_names():
        op.add_column(
            "session_automations",
            sa.Column("active_task_fingerprint", sa.String(), nullable=True),
        )


def downgrade() -> None:
    if "active_task_fingerprint" in _column_names():
        op.drop_column("session_automations", "active_task_fingerprint")
