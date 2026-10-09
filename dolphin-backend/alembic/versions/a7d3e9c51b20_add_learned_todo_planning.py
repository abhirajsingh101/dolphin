"""add learned Todo proposals and task execution provenance

Revision ID: a7d3e9c51b20
Revises: f6b4c8d21e30
Create Date: 2026-09-06 20:10:00

"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "a7d3e9c51b20"
down_revision: Union[str, Sequence[str], None] = "f6b4c8d21e30"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    tables = set(inspector.get_table_names())

    task_columns = {column["name"] for column in inspector.get_columns("tasks")}
    if "origin" not in task_columns:
        op.add_column(
            "tasks",
            sa.Column("origin", sa.String(), server_default="human", nullable=False),
        )
    if "execution_prompt" not in task_columns:
        op.add_column(
            "tasks",
            sa.Column("execution_prompt", sa.Text(), server_default="", nullable=False),
        )
        op.execute(
            "UPDATE tasks SET execution_prompt = "
            "CASE WHEN trim(coalesce(description, '')) <> '' "
            "THEN description ELSE title END"
        )
    if "source_proposal_id" not in task_columns:
        op.add_column(
            "tasks",
            sa.Column("source_proposal_id", sa.String(), nullable=True),
        )
    task_indexes = {index["name"] for index in sa.inspect(op.get_bind()).get_indexes("tasks")}
    if "ix_tasks_source_proposal_id" not in task_indexes:
        op.create_index(
            "ix_tasks_source_proposal_id",
            "tasks",
            ["source_proposal_id"],
            unique=True,
        )

    automation_columns = {
        column["name"]
        for column in inspector.get_columns("session_automations")
    }
    if "pending_task_delivery_fingerprint" not in automation_columns:
        op.add_column(
            "session_automations",
            sa.Column("pending_task_delivery_fingerprint", sa.String(), nullable=True),
        )

    if "task_proposals" not in tables:
        op.create_table(
            "task_proposals",
            sa.Column("id", sa.String(), nullable=False),
            sa.Column("project_id", sa.String(), nullable=False),
            sa.Column("proposal_key", sa.String(), nullable=False),
            sa.Column("title", sa.String(), nullable=False),
            sa.Column("execution_prompt", sa.Text(), nullable=False),
            sa.Column("priority", sa.Integer(), server_default="4", nullable=False),
            sa.Column("desired_outcome", sa.Text(), nullable=False),
            sa.Column("risk_level", sa.String(), server_default="medium", nullable=False),
            sa.Column("acceptance_checks_json", sa.Text(), server_default="[]", nullable=False),
            sa.Column("required_skills_json", sa.Text(), server_default="[]", nullable=False),
            sa.Column("rationale", sa.Text(), nullable=False),
            sa.Column("status", sa.String(), server_default="proposed", nullable=False),
            sa.Column("revision", sa.Integer(), server_default="1", nullable=False),
            sa.Column("last_source_event_key", sa.String(), nullable=False),
            sa.Column("context_fingerprint", sa.String(), nullable=False),
            # Deliberately not a foreign key: the audit link survives Task deletion.
            sa.Column("approved_task_id", sa.String(), nullable=True),
            sa.Column("decided_by", sa.String(), nullable=True),
            sa.Column("decided_at", sa.DateTime(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.Column("updated_at", sa.DateTime(), nullable=False),
            sa.CheckConstraint(
                "status IN ('proposed', 'approved', 'rejected', 'superseded')",
                name="ck_task_proposals_status",
            ),
            sa.CheckConstraint(
                "risk_level IN ('low', 'medium', 'high', 'critical')",
                name="ck_task_proposals_risk",
            ),
            sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint(
                "project_id",
                "proposal_key",
                name="uq_task_proposals_project_key",
            ),
        )
        op.create_index(
            "ix_task_proposals_project_status",
            "task_proposals",
            ["project_id", "status"],
        )

    if "task_planning_events" not in tables:
        op.create_table(
            "task_planning_events",
            sa.Column("id", sa.String(), nullable=False),
            sa.Column("project_id", sa.String(), nullable=False),
            sa.Column("proposal_id", sa.String(), nullable=True),
            sa.Column("proposal_revision", sa.Integer(), nullable=False),
            sa.Column("kind", sa.String(), nullable=False),
            sa.Column("actor", sa.String(), nullable=False),
            sa.Column("source_event_key", sa.String(), nullable=False),
            sa.Column("snapshot_json", sa.Text(), nullable=False),
            sa.Column("snapshot_hash", sa.String(), nullable=False),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.CheckConstraint(
                "kind IN ('proposed', 'updated', 'superseded', 'approved', 'rejected')",
                name="ck_task_planning_events_kind",
            ),
            sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
            sa.ForeignKeyConstraint(["proposal_id"], ["task_proposals.id"], ondelete="SET NULL"),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index(
            "ix_task_planning_events_project_created",
            "task_planning_events",
            ["project_id", "created_at"],
        )


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    tables = set(inspector.get_table_names())
    if "task_planning_events" in tables:
        op.drop_index(
            "ix_task_planning_events_project_created",
            table_name="task_planning_events",
        )
        op.drop_table("task_planning_events")
    if "task_proposals" in tables:
        op.drop_index("ix_task_proposals_project_status", table_name="task_proposals")
        op.drop_table("task_proposals")
    if "tasks" in tables:
        indexes = {index["name"] for index in sa.inspect(op.get_bind()).get_indexes("tasks")}
        if "ix_tasks_source_proposal_id" in indexes:
            op.drop_index("ix_tasks_source_proposal_id", table_name="tasks")
        columns = {column["name"] for column in sa.inspect(op.get_bind()).get_columns("tasks")}
        for name in ("source_proposal_id", "execution_prompt", "origin"):
            if name in columns:
                op.drop_column("tasks", name)
    if "session_automations" in tables:
        columns = {
            column["name"]
            for column in sa.inspect(op.get_bind()).get_columns(
                "session_automations"
            )
        }
        if "pending_task_delivery_fingerprint" in columns:
            op.drop_column(
                "session_automations",
                "pending_task_delivery_fingerprint",
            )
