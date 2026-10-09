"""add session-global OpenClaw automation state and audit events

Revision ID: f6b3c1d9a204
Revises: 9b6f3e8d2a10
Create Date: 2026-09-01 22:30:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "f6b3c1d9a204"
down_revision: Union[str, Sequence[str], None] = "9b6f3e8d2a10"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _tables() -> set[str]:
    return set(sa.inspect(op.get_bind()).get_table_names())


def upgrade() -> None:
    if "session_automations" not in _tables():
        op.create_table(
            "session_automations",
            sa.Column("id", sa.String(), nullable=False),
            sa.Column("project_id", sa.String(), nullable=False),
            sa.Column("session_name", sa.String(), nullable=False),
            sa.Column("tmux_server_id", sa.String(), nullable=False),
            sa.Column("tmux_session_id", sa.String(), nullable=False),
            sa.Column("pane_id", sa.String(), nullable=False),
            sa.Column("pane_pid", sa.Integer(), nullable=False),
            sa.Column("pane_process_start_ticks", sa.Integer(), nullable=False),
            sa.Column("provider", sa.String(), nullable=False),
            sa.Column("mode", sa.String(), server_default="off", nullable=False),
            sa.Column("state", sa.String(), server_default="idle", nullable=False),
            sa.Column("generation", sa.Integer(), server_default="0", nullable=False),
            sa.Column("goal", sa.Text(), server_default="", nullable=False),
            sa.Column("max_turns", sa.Integer(), server_default="8", nullable=False),
            sa.Column("max_minutes", sa.Integer(), server_default="30", nullable=False),
            sa.Column("max_failures", sa.Integer(), server_default="3", nullable=False),
            sa.Column("send_delay_seconds", sa.Integer(), server_default="5", nullable=False),
            sa.Column("turns_used", sa.Integer(), server_default="0", nullable=False),
            sa.Column("consecutive_failures", sa.Integer(), server_default="0", nullable=False),
            sa.Column("activated_at", sa.DateTime(), nullable=True),
            sa.Column("pending_prompt", sa.Text(), nullable=True),
            sa.Column("pending_prompt_hash", sa.String(), nullable=True),
            sa.Column("pending_send_at", sa.DateTime(), nullable=True),
            sa.Column("last_decision", sa.String(), nullable=True),
            sa.Column("last_reason", sa.Text(), nullable=True),
            sa.Column("last_error", sa.String(), nullable=True),
            sa.Column("planner_warning", sa.String(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.Column("updated_at", sa.DateTime(), nullable=False),
            sa.CheckConstraint("mode IN ('off', 'learn', 'active')", name="ck_session_automations_mode"),
            sa.CheckConstraint(
                "state IN ('idle', 'observing', 'thinking', 'countdown', 'sending', "
                "'waiting', 'paused', 'blocked', 'error')",
                name="ck_session_automations_state",
            ),
            sa.CheckConstraint("max_turns BETWEEN 1 AND 100", name="ck_session_automations_max_turns"),
            sa.CheckConstraint("max_minutes BETWEEN 1 AND 1440", name="ck_session_automations_max_minutes"),
            sa.CheckConstraint("max_failures BETWEEN 1 AND 10", name="ck_session_automations_max_failures"),
            sa.CheckConstraint("send_delay_seconds BETWEEN 3 AND 30", name="ck_session_automations_send_delay"),
            sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index(
            "uq_session_automations_tmux_identity",
            "session_automations",
            ["tmux_server_id", "tmux_session_id"],
            unique=True,
        )
        op.create_index(
            "uq_session_automations_project_session",
            "session_automations",
            ["project_id", "session_name"],
            unique=True,
        )

    if "session_automation_events" not in _tables():
        op.create_table(
            "session_automation_events",
            sa.Column("id", sa.String(), nullable=False),
            sa.Column("automation_id", sa.String(), nullable=False),
            sa.Column("event_key", sa.String(), nullable=False),
            sa.Column("kind", sa.String(), nullable=False),
            sa.Column("provider", sa.String(), nullable=True),
            sa.Column("agent_session_id", sa.String(), nullable=True),
            sa.Column("origin", sa.String(), nullable=True),
            sa.Column("content", sa.Text(), nullable=True),
            sa.Column("decision_json", sa.Text(), nullable=True),
            sa.Column("status", sa.String(), server_default="pending", nullable=False),
            sa.Column("error_code", sa.String(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.Column("processed_at", sa.DateTime(), nullable=True),
            sa.CheckConstraint(
                "status IN ('pending', 'processing', 'processed', 'cancelled', 'failed')",
                name="ck_session_automation_events_status",
            ),
            sa.ForeignKeyConstraint(
                ["automation_id"], ["session_automations.id"], ondelete="CASCADE"
            ),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index(
            "uq_session_automation_events_event_key",
            "session_automation_events",
            ["event_key"],
            unique=True,
        )
        op.create_index(
            "ix_session_automation_events_pending",
            "session_automation_events",
            ["status", "created_at"],
        )
        op.create_index(
            "ix_session_automation_events_automation",
            "session_automation_events",
            ["automation_id", "created_at"],
        )


def downgrade() -> None:
    tables = _tables()
    if "session_automation_events" in tables:
        op.drop_table("session_automation_events")
    if "session_automations" in tables:
        op.drop_table("session_automations")
