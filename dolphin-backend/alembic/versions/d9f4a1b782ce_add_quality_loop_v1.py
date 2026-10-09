"""add durable Quality Loop v1 contracts and evidence

Revision ID: d9f4a1b782ce
Revises: c4a8d2f901be
Create Date: 2026-09-05 14:00:00

"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "d9f4a1b782ce"
down_revision: Union[str, Sequence[str], None] = "c4a8d2f901be"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    existing = set(inspector.get_table_names())

    if "task_quality_contracts" not in existing:
        op.create_table(
            "task_quality_contracts",
            sa.Column("task_id", sa.String(), nullable=False),
            sa.Column("project_id", sa.String(), nullable=False),
            sa.Column("desired_outcome", sa.Text(), nullable=False),
            sa.Column("risk_level", sa.String(), nullable=False),
            sa.Column("stage", sa.String(), nullable=False),
            sa.Column("acceptance_checks_json", sa.Text(), nullable=False),
            sa.Column("required_skills_json", sa.Text(), nullable=False),
            sa.Column("human_review_required", sa.Boolean(), nullable=False),
            sa.Column("revision", sa.Integer(), nullable=False),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.Column("updated_at", sa.DateTime(), nullable=False),
            sa.CheckConstraint(
                "risk_level IN ('low', 'medium', 'high', 'critical')",
                name="ck_task_quality_contract_risk",
            ),
            sa.CheckConstraint(
                "stage IN ('discover', 'specify', 'plan', 'execute', "
                "'verify', 'review', 'done')",
                name="ck_task_quality_contract_stage",
            ),
            sa.ForeignKeyConstraint(
                ["project_id"], ["projects.id"], ondelete="CASCADE"
            ),
            sa.ForeignKeyConstraint(["task_id"], ["tasks.id"], ondelete="CASCADE"),
            sa.PrimaryKeyConstraint("task_id"),
        )
        op.create_index(
            "ix_task_quality_contracts_project_id",
            "task_quality_contracts",
            ["project_id"],
        )

    if "task_evidence_receipts" not in existing:
        op.create_table(
            "task_evidence_receipts",
            sa.Column("id", sa.String(), nullable=False),
            sa.Column("task_id", sa.String(), nullable=False),
            sa.Column("project_id", sa.String(), nullable=False),
            sa.Column("contract_revision", sa.Integer(), nullable=False),
            sa.Column("producer", sa.String(), nullable=False),
            sa.Column("summary", sa.Text(), nullable=False),
            sa.Column("checks_json", sa.Text(), nullable=False),
            sa.Column("status", sa.String(), nullable=False),
            sa.Column("reviewer", sa.String(), nullable=True),
            sa.Column("review_reason", sa.Text(), nullable=True),
            sa.Column("submitted_at", sa.DateTime(), nullable=False),
            sa.Column("reviewed_at", sa.DateTime(), nullable=True),
            sa.CheckConstraint(
                "status IN ('submitted', 'accepted', 'rejected')",
                name="ck_task_evidence_receipt_status",
            ),
            sa.ForeignKeyConstraint(
                ["project_id"], ["projects.id"], ondelete="CASCADE"
            ),
            sa.ForeignKeyConstraint(["task_id"], ["tasks.id"], ondelete="CASCADE"),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index(
            "ix_task_evidence_receipts_project_id",
            "task_evidence_receipts",
            ["project_id"],
        )
        op.create_index(
            "ix_task_evidence_receipts_task_id",
            "task_evidence_receipts",
            ["task_id"],
        )
        op.create_index(
            "ix_task_evidence_task_revision",
            "task_evidence_receipts",
            ["task_id", "contract_revision"],
        )

    if "task_outcome_lessons" not in existing:
        op.create_table(
            "task_outcome_lessons",
            sa.Column("id", sa.String(), nullable=False),
            sa.Column("project_id", sa.String(), nullable=False),
            sa.Column("task_id", sa.String(), nullable=False),
            sa.Column("receipt_id", sa.String(), nullable=False),
            sa.Column("category", sa.String(), nullable=False),
            sa.Column("statement", sa.Text(), nullable=False),
            sa.Column("status", sa.String(), nullable=False),
            sa.Column("decided_by", sa.String(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.Column("decided_at", sa.DateTime(), nullable=True),
            sa.CheckConstraint(
                "category IN ('success', 'failure', 'correction', 'workflow')",
                name="ck_task_outcome_lesson_category",
            ),
            sa.CheckConstraint(
                "status IN ('proposed', 'approved', 'rejected', 'superseded')",
                name="ck_task_outcome_lesson_status",
            ),
            sa.ForeignKeyConstraint(
                ["receipt_id"], ["task_evidence_receipts.id"], ondelete="CASCADE"
            ),
            sa.ForeignKeyConstraint(
                ["project_id"], ["projects.id"], ondelete="CASCADE"
            ),
            sa.ForeignKeyConstraint(["task_id"], ["tasks.id"], ondelete="CASCADE"),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("receipt_id", name="uq_task_outcome_lesson_receipt"),
        )
        op.create_index(
            "ix_task_outcome_lessons_project_id",
            "task_outcome_lessons",
            ["project_id"],
        )
        op.create_index(
            "ix_task_outcome_lessons_task_id",
            "task_outcome_lessons",
            ["task_id"],
        )

    if "task_quality_events" not in existing:
        op.create_table(
            "task_quality_events",
            sa.Column("id", sa.String(), nullable=False),
            sa.Column("project_id", sa.String(), nullable=False),
            sa.Column("task_id", sa.String(), nullable=False),
            sa.Column("contract_revision", sa.Integer(), nullable=False),
            sa.Column("kind", sa.String(), nullable=False),
            sa.Column("from_stage", sa.String(), nullable=True),
            sa.Column("to_stage", sa.String(), nullable=True),
            sa.Column("actor", sa.String(), nullable=False),
            sa.Column("reason", sa.Text(), nullable=True),
            sa.Column("receipt_id", sa.String(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.ForeignKeyConstraint(
                ["project_id"], ["projects.id"], ondelete="CASCADE"
            ),
            sa.ForeignKeyConstraint(["task_id"], ["tasks.id"], ondelete="CASCADE"),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index(
            "ix_task_quality_events_project_id",
            "task_quality_events",
            ["project_id"],
        )
        op.create_index(
            "ix_task_quality_events_task_id",
            "task_quality_events",
            ["task_id"],
        )
        op.create_index(
            "ix_task_quality_event_task_created",
            "task_quality_events",
            ["task_id", "created_at"],
        )


def downgrade() -> None:
    existing = set(sa.inspect(op.get_bind()).get_table_names())
    for table in (
        "task_quality_events",
        "task_outcome_lessons",
        "task_evidence_receipts",
        "task_quality_contracts",
    ):
        if table in existing:
            op.drop_table(table)
