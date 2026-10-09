"""bind active queue tasks to their owning automation

Revision ID: f6b4c8d21e30
Revises: e2c8b4195a7d
Create Date: 2026-09-06 16:30:00

"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "f6b4c8d21e30"
down_revision: Union[str, Sequence[str], None] = "e2c8b4195a7d"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if "task_workflows" not in inspector.get_table_names():
        return
    columns = {column["name"] for column in inspector.get_columns("task_workflows")}
    if "automation_owner_id" not in columns:
        op.add_column(
            "task_workflows",
            sa.Column("automation_owner_id", sa.String(), nullable=True),
        )
    indexes = {index["name"] for index in sa.inspect(op.get_bind()).get_indexes("task_workflows")}
    if "ix_task_workflows_automation_owner_id" not in indexes:
        op.create_index(
            "ix_task_workflows_automation_owner_id",
            "task_workflows",
            ["automation_owner_id"],
        )


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if "task_workflows" not in inspector.get_table_names():
        return
    indexes = {index["name"] for index in inspector.get_indexes("task_workflows")}
    if "ix_task_workflows_automation_owner_id" in indexes:
        op.drop_index(
            "ix_task_workflows_automation_owner_id",
            table_name="task_workflows",
        )
    columns = {column["name"] for column in sa.inspect(op.get_bind()).get_columns("task_workflows")}
    if "automation_owner_id" in columns:
        op.drop_column("task_workflows", "automation_owner_id")
