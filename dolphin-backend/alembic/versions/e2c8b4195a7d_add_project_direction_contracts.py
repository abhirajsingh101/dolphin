"""add governed project direction contracts

Revision ID: e2c8b4195a7d
Revises: d9f4a1b782ce
Create Date: 2026-09-05 18:30:00

"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "e2c8b4195a7d"
down_revision: Union[str, Sequence[str], None] = "d9f4a1b782ce"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    existing = set(inspector.get_table_names())

    if "project_direction_contracts" not in existing:
        op.create_table(
            "project_direction_contracts",
            sa.Column("project_id", sa.String(), nullable=False),
            sa.Column("status", sa.String(), nullable=False, server_default="draft"),
            sa.Column("problem", sa.Text(), nullable=False, server_default=""),
            sa.Column("target_users", sa.Text(), nullable=False, server_default=""),
            sa.Column("vision", sa.Text(), nullable=False, server_default=""),
            sa.Column("value_proposition", sa.Text(), nullable=False, server_default=""),
            sa.Column("current_goal", sa.Text(), nullable=False, server_default=""),
            sa.Column("desired_outcome", sa.Text(), nullable=False, server_default=""),
            sa.Column("success_metrics_json", sa.Text(), nullable=False, server_default="[]"),
            sa.Column("non_goals_json", sa.Text(), nullable=False, server_default="[]"),
            sa.Column("boundaries_json", sa.Text(), nullable=False, server_default="[]"),
            sa.Column("assumptions_json", sa.Text(), nullable=False, server_default="[]"),
            sa.Column("source_refs_json", sa.Text(), nullable=False, server_default="[]"),
            sa.Column("task_ids_json", sa.Text(), nullable=False, server_default="[]"),
            sa.Column("methodology", sa.String(), nullable=False, server_default="bmad-method"),
            sa.Column("methodology_version", sa.String(), nullable=False),
            sa.Column("methodology_sha", sa.String(), nullable=False),
            sa.Column("methodology_url", sa.Text(), nullable=False),
            sa.Column("revision", sa.Integer(), nullable=False, server_default="1"),
            sa.Column("approved_revision", sa.Integer(), nullable=True),
            sa.Column("approved_by", sa.String(), nullable=True),
            sa.Column("approved_at", sa.DateTime(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.Column("updated_at", sa.DateTime(), nullable=False),
            sa.CheckConstraint(
                "status IN ('draft', 'approved', 'completed', 'cancelled', 'superseded')",
                name="ck_project_direction_contract_status",
            ),
            sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
            sa.PrimaryKeyConstraint("project_id"),
        )

    if "project_direction_events" not in existing:
        op.create_table(
            "project_direction_events",
            sa.Column("id", sa.String(), nullable=False),
            sa.Column("project_id", sa.String(), nullable=False),
            sa.Column("revision", sa.Integer(), nullable=False),
            sa.Column("kind", sa.String(), nullable=False),
            sa.Column("actor", sa.String(), nullable=False),
            sa.Column("reason", sa.Text(), nullable=True),
            sa.Column("snapshot_json", sa.Text(), nullable=False),
            sa.Column("snapshot_hash", sa.String(), nullable=False),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.CheckConstraint(
                "kind IN ('draft_saved', 'approved', 'completed', 'cancelled', 'superseded')",
                name="ck_project_direction_event_kind",
            ),
            sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index(
            "ix_project_direction_events_project_id",
            "project_direction_events",
            ["project_id"],
        )
        op.create_index(
            "ix_project_direction_events_project_created",
            "project_direction_events",
            ["project_id", "created_at"],
        )

    session_columns = {
        column["name"] for column in inspector.get_columns("session_automations")
    }
    if "active_direction_revision" not in session_columns:
        op.add_column(
            "session_automations",
            sa.Column("active_direction_revision", sa.Integer(), nullable=True),
        )
    if "active_direction_fingerprint" not in session_columns:
        op.add_column(
            "session_automations",
            sa.Column("active_direction_fingerprint", sa.String(), nullable=True),
        )

    check_names = {
        constraint["name"]
        for constraint in sa.inspect(op.get_bind()).get_check_constraints(
            "session_automations"
        )
        if constraint.get("name")
    }
    with op.batch_alter_table("session_automations", recreate="always") as batch_op:
        if "ck_session_automations_work_scope" in check_names:
            batch_op.drop_constraint(
                "ck_session_automations_work_scope",
                type_="check",
            )
        batch_op.create_check_constraint(
            "ck_session_automations_work_scope",
            "work_scope IN ('session_goal', 'project_queue', 'direction_queue')",
        )


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if "session_automations" in inspector.get_table_names():
        # Existing direction-backed rows cannot satisfy the predecessor check.
        # Preserve them as the closest supported queue scope before SQLite
        # recreates the table with that narrower constraint.
        op.execute(
            "UPDATE session_automations SET work_scope = 'project_queue' "
            "WHERE work_scope = 'direction_queue'"
        )
        check_names = {
            constraint["name"]
            for constraint in inspector.get_check_constraints("session_automations")
            if constraint.get("name")
        }
        with op.batch_alter_table("session_automations", recreate="always") as batch_op:
            if "ck_session_automations_work_scope" in check_names:
                batch_op.drop_constraint(
                    "ck_session_automations_work_scope",
                    type_="check",
                )
            batch_op.create_check_constraint(
                "ck_session_automations_work_scope",
                "work_scope IN ('session_goal', 'project_queue')",
            )
        columns = {column["name"] for column in inspector.get_columns("session_automations")}
        if "active_direction_fingerprint" in columns:
            op.drop_column("session_automations", "active_direction_fingerprint")
        if "active_direction_revision" in columns:
            op.drop_column("session_automations", "active_direction_revision")
    existing = set(inspector.get_table_names())
    if "project_direction_events" in existing:
        op.drop_table("project_direction_events")
    if "project_direction_contracts" in existing:
        op.drop_table("project_direction_contracts")
