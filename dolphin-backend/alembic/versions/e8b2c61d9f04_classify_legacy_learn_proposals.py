"""classify legacy Learn proposals from their direct action titles

Revision ID: e8b2c61d9f04
Revises: d7f1b04c8a21
Create Date: 2026-09-08 17:36:00

"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "e8b2c61d9f04"
down_revision: Union[str, Sequence[str], None] = "d7f1b04c8a21"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_LEGACY_FILTER = """
confidence = 50
AND evidence_summary = 'Legacy learned proposal.'
AND why_now = 'Preserved from the current learned plan.'
"""


def upgrade() -> None:
    op.execute(
        """
        UPDATE task_proposals
        SET work_type = CASE
            WHEN lower(trim(title)) GLOB 'fix *'
              OR lower(trim(title)) GLOB 'repair *'
              OR lower(trim(title)) GLOB 'correct *'
                THEN 'bug_fix'
            WHEN lower(trim(title)) GLOB 'implement *'
              OR lower(trim(title)) GLOB 'build *'
              OR lower(trim(title)) GLOB 'add *'
              OR lower(trim(title)) GLOB 'create *'
              OR lower(trim(title)) GLOB 'enable *'
              OR lower(trim(title)) GLOB 'integrate *'
                THEN 'feature'
            WHEN lower(trim(title)) GLOB 'research *'
              OR lower(trim(title)) GLOB 'study *'
              OR lower(trim(title)) GLOB 'compare *'
                THEN 'research'
            WHEN lower(trim(title)) GLOB 'experiment *'
              OR lower(trim(title)) GLOB 'benchmark *'
              OR lower(trim(title)) GLOB 'prototype *'
                THEN 'experiment'
            WHEN lower(trim(title)) GLOB 'validate *'
              OR lower(trim(title)) GLOB 'verify *'
              OR lower(trim(title)) GLOB 'reverify *'
              OR lower(trim(title)) GLOB 'test *'
              OR lower(trim(title)) GLOB 'prove *'
              OR lower(trim(title)) GLOB 'audit *'
              OR lower(trim(title)) GLOB 'assess *'
              OR lower(trim(title)) GLOB 'inspect *'
              OR lower(trim(title)) GLOB 'review *'
              OR lower(trim(title)) GLOB 'measure *'
                THEN 'validation'
            WHEN lower(trim(title)) GLOB 'write *'
              OR lower(trim(title)) GLOB 'document *'
              OR lower(trim(title)) GLOB 'prepare *'
                THEN 'documentation'
            WHEN lower(trim(title)) GLOB 'deploy *'
              OR lower(trim(title)) GLOB 'release *'
              OR lower(trim(title)) GLOB 'configure *'
              OR lower(trim(title)) GLOB 'operate *'
                THEN 'operations'
            ELSE 'maintenance'
        END
        WHERE """
        + _LEGACY_FILTER
    )


def downgrade() -> None:
    op.execute(
        "UPDATE task_proposals SET work_type = 'maintenance' WHERE "
        + _LEGACY_FILTER
    )
