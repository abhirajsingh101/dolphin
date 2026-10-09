"""harden session automation ownership, privacy, and observability

Revision ID: a91d0c4e7b62
Revises: f6b3c1d9a204
Create Date: 2026-09-02 12:30:00

"""
from __future__ import annotations

import hashlib
import json
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "a91d0c4e7b62"
down_revision: Union[str, Sequence[str], None] = "f6b3c1d9a204"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


AUTOMATION_COLUMNS = (
    sa.Column("pending_prompt_fingerprint", sa.String(), nullable=True),
    sa.Column("pending_source_event_key", sa.String(), nullable=True),
    sa.Column("pending_prompt_expires_at", sa.DateTime(), nullable=True),
    sa.Column("last_prompt_fingerprint", sa.String(), nullable=True),
    sa.Column("no_progress_count", sa.Integer(), server_default="0", nullable=False),
    sa.Column("last_learning_error", sa.String(), nullable=True),
)

EVENT_COLUMNS = (
    sa.Column("source_event_key", sa.String(), nullable=True),
    sa.Column("prompt_hash", sa.String(), nullable=True),
    sa.Column("snapshot_hash", sa.String(), nullable=True),
    sa.Column("policy_version", sa.String(), nullable=True),
    sa.Column("tmux_server_id", sa.String(), nullable=True),
    sa.Column("tmux_session_id", sa.String(), nullable=True),
    sa.Column("pane_id", sa.String(), nullable=True),
    sa.Column("generation", sa.Integer(), nullable=True),
)


def _column_names(table: str) -> set[str]:
    return {column["name"] for column in sa.inspect(op.get_bind()).get_columns(table)}


def upgrade() -> None:
    tables = set(sa.inspect(op.get_bind()).get_table_names())
    if "session_automations" not in tables or "session_automation_events" not in tables:
        return
    automation_columns = _column_names("session_automations")
    for column in AUTOMATION_COLUMNS:
        if column.name not in automation_columns:
            op.add_column("session_automations", column)
    event_columns = _column_names("session_automation_events")
    for column in EVENT_COLUMNS:
        if column.name not in event_columns:
            op.add_column("session_automation_events", column)

    # Older builds briefly stored generated continuation prompts in audit rows.
    # Retain only a one-way digest and redact both direct and decision payload copies.
    connection = op.get_bind()
    rows = connection.execute(
        sa.text(
            "SELECT id, kind, content, decision_json FROM session_automation_events "
            "WHERE content IS NOT NULL OR decision_json IS NOT NULL"
        )
    ).mappings()
    for row in rows:
        prompt = row["content"] if row["kind"] in {"send", "send_claimed"} else None
        decision_json = row["decision_json"]
        if decision_json:
            try:
                payload = json.loads(decision_json)
            except (TypeError, json.JSONDecodeError):
                payload = None
            if isinstance(payload, dict) and isinstance(payload.get("next_prompt"), str):
                prompt = prompt or payload["next_prompt"]
                payload["next_prompt"] = None
                decision_json = json.dumps(payload, separators=(",", ":"))
        connection.execute(
            sa.text(
                "UPDATE session_automation_events SET content = CASE "
                "WHEN kind IN ('send', 'send_claimed') THEN NULL ELSE content END, "
                "decision_json = :decision_json, prompt_hash = COALESCE(prompt_hash, :prompt_hash) "
                "WHERE id = :id"
            ),
            {
                "id": row["id"],
                "decision_json": decision_json,
                "prompt_hash": hashlib.sha256(prompt.encode()).hexdigest() if prompt else None,
            },
        )


def downgrade() -> None:
    tables = set(sa.inspect(op.get_bind()).get_table_names())
    if "session_automation_events" in tables:
        existing = _column_names("session_automation_events")
        for column in reversed(EVENT_COLUMNS):
            if column.name in existing:
                op.drop_column("session_automation_events", column.name)
    if "session_automations" in tables:
        existing = _column_names("session_automations")
        for column in reversed(AUTOMATION_COLUMNS):
            if column.name in existing:
                op.drop_column("session_automations", column.name)
