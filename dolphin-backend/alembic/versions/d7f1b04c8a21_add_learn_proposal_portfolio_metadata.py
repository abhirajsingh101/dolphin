"""add Learn proposal portfolio metadata

Revision ID: d7f1b04c8a21
Revises: a4c8e12f7b90
Create Date: 2026-09-08 15:00:00

"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "d7f1b04c8a21"
down_revision: Union[str, Sequence[str], None] = "a4c8e12f7b90"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    columns = {
        column["name"]
        for column in sa.inspect(op.get_bind()).get_columns("task_proposals")
    }
    additions = (
        sa.Column(
            "work_type",
            sa.String(),
            server_default="maintenance",
            nullable=False,
        ),
        sa.Column(
            "evidence_basis",
            sa.String(),
            server_default="source_gap",
            nullable=False,
        ),
        sa.Column(
            "evidence_summary",
            sa.Text(),
            server_default="Legacy learned proposal.",
            nullable=False,
        ),
        sa.Column(
            "why_now",
            sa.Text(),
            server_default="Preserved from the current learned plan.",
            nullable=False,
        ),
        sa.Column("confidence", sa.Integer(), server_default="50", nullable=False),
        sa.Column(
            "depends_on_proposal_keys_json",
            sa.Text(),
            server_default="[]",
            nullable=False,
        ),
    )
    for column in additions:
        if column.name not in columns:
            op.add_column("task_proposals", column)


def downgrade() -> None:
    columns = {
        column["name"]
        for column in sa.inspect(op.get_bind()).get_columns("task_proposals")
    }
    for name in (
        "depends_on_proposal_keys_json",
        "confidence",
        "why_now",
        "evidence_summary",
        "evidence_basis",
        "work_type",
    ):
        if name in columns:
            op.drop_column("task_proposals", name)
