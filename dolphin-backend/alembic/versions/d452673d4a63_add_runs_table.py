"""add runs table

Revision ID: d452673d4a63
Revises: 6431220ddcf5
Create Date: 2026-08-09 11:09:17.471401

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'd452673d4a63'
down_revision: Union[str, Sequence[str], None] = '6431220ddcf5'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _inspector():
    """Reflect the database this migration is running against."""
    return sa.inspect(op.get_bind())


def upgrade() -> None:
    """Create the runs table and its state/task_id/session_name indexes.

    Guarded like 6431220ddcf5, and for the same shape of reason: a pre-Alembic
    database is stamped at baseline after init_db() has already run
    create_all(), which builds every table `models.py` declares — including
    `runs`, now that it is declared there — complete with its indexes, in one
    step. An unconditional create_table here would then collide with a table
    that already exists. Unlike the ADD COLUMN case that 6431220ddcf5 patches,
    create_all() never leaves the table without its indexes, so a single
    table-existence check is enough to guard both.
    """
    if "runs" in _inspector().get_table_names():
        return

    op.create_table(
        "runs",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("task_id", sa.String(), nullable=False),
        sa.Column("project_id", sa.String(), nullable=False),
        sa.Column("session_name", sa.String(), nullable=False),
        sa.Column("agent", sa.String(), nullable=False),
        sa.Column("workspace_path", sa.Text(), nullable=False),
        sa.Column("state", sa.String(), server_default="dispatched", nullable=False),
        sa.Column("dispatched_at", sa.DateTime(), nullable=False),
        sa.Column("started_at", sa.DateTime(), nullable=True),
        sa.Column("ended_at", sa.DateTime(), nullable=True),
        sa.Column("last_event_at", sa.DateTime(), nullable=True),
        sa.Column("turn_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("receipt_path", sa.Text(), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"]),
        sa.ForeignKeyConstraint(["task_id"], ["tasks.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    with op.batch_alter_table("runs", schema=None) as batch_op:
        batch_op.create_index(batch_op.f("ix_runs_session_name"), ["session_name"], unique=False)
        batch_op.create_index(batch_op.f("ix_runs_state"), ["state"], unique=False)
        batch_op.create_index(batch_op.f("ix_runs_task_id"), ["task_id"], unique=False)


def downgrade() -> None:
    """Drop the runs table and its indexes, if present."""
    if "runs" not in _inspector().get_table_names():
        return

    with op.batch_alter_table("runs", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_runs_task_id"))
        batch_op.drop_index(batch_op.f("ix_runs_state"))
        batch_op.drop_index(batch_op.f("ix_runs_session_name"))

    op.drop_table("runs")
