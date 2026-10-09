"""add bounded Active project-queue scope

Revision ID: b7e1f3c42a90
Revises: a91d0c4e7b62
Create Date: 2026-09-04 19:45:00

"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "b7e1f3c42a90"
down_revision: Union[str, Sequence[str], None] = "a91d0c4e7b62"
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


def _check_names() -> set[str]:
    inspector = sa.inspect(op.get_bind())
    if "session_automations" not in inspector.get_table_names():
        return set()
    return {
        constraint["name"]
        for constraint in inspector.get_check_constraints("session_automations")
        if constraint.get("name")
    }


def upgrade() -> None:
    columns = _column_names()
    additions = (
        sa.Column(
            "work_scope",
            sa.String(),
            server_default="session_goal",
            nullable=False,
        ),
        sa.Column(
            "initial_goal_completed",
            sa.Boolean(),
            server_default=sa.text("0"),
            nullable=False,
        ),
        sa.Column("active_task_id", sa.String(), nullable=True),
        sa.Column("active_task_title", sa.Text(), nullable=True),
        sa.Column("active_task_source", sa.String(), nullable=True),
    )
    for column in additions:
        if column.name not in columns:
            op.add_column("session_automations", column)

    if "ck_session_automations_work_scope" not in _check_names():
        with op.batch_alter_table(
            "session_automations",
            recreate="always",
        ) as batch_op:
            batch_op.create_check_constraint(
                "ck_session_automations_work_scope",
                "work_scope IN ('session_goal', 'project_queue')",
            )

    indexes = {
        index["name"]
        for index in sa.inspect(op.get_bind()).get_indexes("session_automations")
    }
    if "ix_session_automations_active_task_id" not in indexes:
        op.create_index(
            "ix_session_automations_active_task_id",
            "session_automations",
            ["active_task_id"],
            unique=False,
        )


def downgrade() -> None:
    columns = _column_names()
    indexes = {
        index["name"]
        for index in sa.inspect(op.get_bind()).get_indexes("session_automations")
    }
    if "ix_session_automations_active_task_id" in indexes:
        op.drop_index(
            "ix_session_automations_active_task_id",
            table_name="session_automations",
        )
    if "ck_session_automations_work_scope" in _check_names():
        with op.batch_alter_table(
            "session_automations",
            recreate="always",
        ) as batch_op:
            batch_op.drop_constraint(
                "ck_session_automations_work_scope",
                type_="check",
            )
    for name in (
        "active_task_source",
        "active_task_title",
        "active_task_id",
        "initial_goal_completed",
        "work_scope",
    ):
        if name in columns:
            op.drop_column("session_automations", name)
