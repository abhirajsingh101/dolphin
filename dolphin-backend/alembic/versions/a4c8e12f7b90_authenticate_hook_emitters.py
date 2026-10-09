"""authenticate and order local automation hook emitters

Revision ID: a4c8e12f7b90
Revises: f2d7a91c4e8b
Create Date: 2026-09-08 18:00:00

"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "a4c8e12f7b90"
down_revision: Union[str, Sequence[str], None] = "f2d7a91c4e8b"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


INTEGER_COLUMNS = (
    "last_human_input_boot_ticks",
    "last_hook_peer_pid",
    "last_hook_peer_start_ticks",
    "last_hook_provider_pid",
    "last_hook_provider_start_ticks",
)


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if "session_automations" not in inspector.get_table_names():
        return
    columns = {item["name"] for item in inspector.get_columns("session_automations")}
    if "last_human_input_boot_ticks" not in columns:
        op.add_column(
            "session_automations",
            sa.Column(
                "last_human_input_boot_ticks",
                sa.Integer(),
                server_default=sa.text("0"),
                nullable=False,
            ),
        )
    for name in INTEGER_COLUMNS[1:]:
        if name not in columns:
            op.add_column(
                "session_automations",
                sa.Column(name, sa.Integer(), nullable=True),
            )
    if "last_hook_event_fingerprint" not in columns:
        op.add_column(
            "session_automations",
            sa.Column("last_hook_event_fingerprint", sa.String(), nullable=True),
        )


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if "session_automations" not in inspector.get_table_names():
        return
    columns = {item["name"] for item in inspector.get_columns("session_automations")}
    if "last_hook_event_fingerprint" in columns:
        op.drop_column("session_automations", "last_hook_event_fingerprint")
    for name in reversed(INTEGER_COLUMNS):
        if name in columns:
            op.drop_column("session_automations", name)
