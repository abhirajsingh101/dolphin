"""add operational Chief conversations

Revision ID: c7c7f07a1b1e
Revises: d452673d4a63
Create Date: 2026-08-11 18:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "c7c7f07a1b1e"
down_revision: Union[str, Sequence[str], None] = "d452673d4a63"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _inspector():
    return sa.inspect(op.get_bind())


def _index_names(table_name: str) -> set[str]:
    return {item["name"] for item in _inspector().get_indexes(table_name)}


def _create_index_if_missing(
    name: str,
    table_name: str,
    columns: list[str],
    *,
    unique: bool = False,
) -> None:
    if name not in _index_names(table_name):
        op.create_index(name, table_name, columns, unique=unique)


def upgrade() -> None:
    """Create five isolated conversation tables and their explicit indexes.

    The guards support the same pre-Alembic ``create_all`` path as the prior
    migrations and also let a non-transactional SQLite DDL run resume without
    recreating an already-created table.
    """

    tables = set(_inspector().get_table_names())
    if "chief_threads" not in tables:
        op.create_table(
            "chief_threads",
            sa.Column("id", sa.String(), nullable=False),
            sa.Column("title", sa.String(), nullable=False),
            sa.Column("moment_fingerprint", sa.String(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.Column("updated_at", sa.DateTime(), nullable=False),
            sa.Column("version", sa.Integer(), nullable=False),
            sa.CheckConstraint(
                "length(title) BETWEEN 1 AND 80",
                name="ck_chief_threads_title_length",
            ),
            sa.PrimaryKeyConstraint("id"),
        )
    _create_index_if_missing(
        "ix_chief_threads_updated_at",
        "chief_threads",
        ["updated_at"],
    )
    _create_index_if_missing(
        "uq_chief_threads_moment_fingerprint",
        "chief_threads",
        ["moment_fingerprint"],
        unique=True,
    )

    tables = set(_inspector().get_table_names())
    if "chief_moment_snapshots" not in tables:
        op.create_table(
            "chief_moment_snapshots",
            sa.Column("id", sa.String(), nullable=False),
            sa.Column("thread_id", sa.String(), nullable=False),
            sa.Column("fingerprint", sa.String(), nullable=False),
            sa.Column("schema_version", sa.String(), nullable=False),
            sa.Column("snapshot_json", sa.Text(), nullable=False),
            sa.Column("snapshot_hash", sa.String(), nullable=False),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.CheckConstraint(
                "length(snapshot_hash) = 64",
                name="ck_chief_moment_snapshots_hash_length",
            ),
            sa.ForeignKeyConstraint(
                ["thread_id"],
                ["chief_threads.id"],
                ondelete="CASCADE",
            ),
            sa.PrimaryKeyConstraint("id"),
        )
    _create_index_if_missing(
        "uq_chief_moment_snapshots_thread_id",
        "chief_moment_snapshots",
        ["thread_id"],
        unique=True,
    )
    _create_index_if_missing(
        "uq_chief_moment_snapshots_fingerprint",
        "chief_moment_snapshots",
        ["fingerprint"],
        unique=True,
    )

    tables = set(_inspector().get_table_names())
    if "chief_messages" not in tables:
        op.create_table(
            "chief_messages",
            sa.Column("id", sa.String(), nullable=False),
            sa.Column("thread_id", sa.String(), nullable=False),
            sa.Column("role", sa.String(), nullable=False),
            sa.Column("kind", sa.String(), nullable=False),
            sa.Column("text", sa.Text(), nullable=False),
            sa.Column("payload_json", sa.Text(), nullable=False),
            sa.Column("in_reply_to_message_id", sa.String(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.CheckConstraint(
                "role IN ('user', 'assistant')",
                name="ck_chief_messages_role",
            ),
            sa.CheckConstraint(
                "kind IN ('text', 'response')",
                name="ck_chief_messages_kind",
            ),
            sa.CheckConstraint(
                "length(text) BETWEEN 1 AND 12000",
                name="ck_chief_messages_text_length",
            ),
            sa.ForeignKeyConstraint(
                ["in_reply_to_message_id"],
                ["chief_messages.id"],
                ondelete="CASCADE",
            ),
            sa.ForeignKeyConstraint(
                ["thread_id"],
                ["chief_threads.id"],
                ondelete="CASCADE",
            ),
            sa.PrimaryKeyConstraint("id"),
        )
    _create_index_if_missing(
        "ix_chief_messages_thread_created_at",
        "chief_messages",
        ["thread_id", "created_at"],
    )
    _create_index_if_missing(
        "uq_chief_messages_in_reply_to_message_id",
        "chief_messages",
        ["in_reply_to_message_id"],
        unique=True,
    )

    tables = set(_inspector().get_table_names())
    if "chief_turn_requests" not in tables:
        op.create_table(
            "chief_turn_requests",
            sa.Column("id", sa.String(), nullable=False),
            sa.Column("thread_id", sa.String(), nullable=False),
            sa.Column("idempotency_key", sa.String(), nullable=False),
            sa.Column("user_message_id", sa.String(), nullable=False),
            sa.Column("assistant_message_id", sa.String(), nullable=True),
            sa.Column("status", sa.String(), nullable=False),
            sa.Column("attempt_count", sa.Integer(), nullable=False),
            sa.Column("response_bytes", sa.LargeBinary(), nullable=True),
            sa.Column("error_code", sa.String(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.Column("updated_at", sa.DateTime(), nullable=False),
            sa.CheckConstraint(
                "status IN ('pending', 'completed', 'failed', 'timed_out', 'cancelled')",
                name="ck_chief_turn_requests_status",
            ),
            sa.CheckConstraint(
                "length(idempotency_key) = 36",
                name="ck_chief_turn_requests_idempotency_key_length",
            ),
            sa.ForeignKeyConstraint(
                ["assistant_message_id"],
                ["chief_messages.id"],
                ondelete="CASCADE",
            ),
            sa.ForeignKeyConstraint(
                ["thread_id"],
                ["chief_threads.id"],
                ondelete="CASCADE",
            ),
            sa.ForeignKeyConstraint(
                ["user_message_id"],
                ["chief_messages.id"],
                ondelete="CASCADE",
            ),
            sa.PrimaryKeyConstraint("id"),
        )
    _create_index_if_missing(
        "uq_chief_turn_requests_thread_id_idempotency_key",
        "chief_turn_requests",
        ["thread_id", "idempotency_key"],
        unique=True,
    )
    _create_index_if_missing(
        "ix_chief_turn_requests_thread_status",
        "chief_turn_requests",
        ["thread_id", "status"],
    )

    tables = set(_inspector().get_table_names())
    if "chief_feedback" not in tables:
        op.create_table(
            "chief_feedback",
            sa.Column("id", sa.String(), nullable=False),
            sa.Column("thread_id", sa.String(), nullable=True),
            sa.Column("message_id", sa.String(), nullable=True),
            sa.Column("moment_fingerprint", sa.String(), nullable=True),
            sa.Column("value", sa.String(), nullable=False),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.Column("updated_at", sa.DateTime(), nullable=False),
            sa.CheckConstraint(
                "((message_id IS NOT NULL AND moment_fingerprint IS NULL) OR "
                "(message_id IS NULL AND moment_fingerprint IS NOT NULL))",
                name="ck_chief_feedback_target",
            ),
            sa.CheckConstraint(
                "value IN ('helpful', 'not_helpful')",
                name="ck_chief_feedback_value",
            ),
            sa.ForeignKeyConstraint(
                ["message_id"],
                ["chief_messages.id"],
                ondelete="CASCADE",
            ),
            sa.ForeignKeyConstraint(
                ["thread_id"],
                ["chief_threads.id"],
                ondelete="CASCADE",
            ),
            sa.PrimaryKeyConstraint("id"),
        )
    _create_index_if_missing(
        "uq_chief_feedback_message_id",
        "chief_feedback",
        ["message_id"],
        unique=True,
    )
    _create_index_if_missing(
        "uq_chief_feedback_moment_fingerprint",
        "chief_feedback",
        ["moment_fingerprint"],
        unique=True,
    )


def _drop_table_with_indexes(table_name: str) -> None:
    if table_name not in _inspector().get_table_names():
        return
    for name in sorted(_index_names(table_name)):
        op.drop_index(name, table_name=table_name)
    op.drop_table(table_name)


def downgrade() -> None:
    """Remove only Phase 7 operational conversation state."""

    _drop_table_with_indexes("chief_feedback")
    _drop_table_with_indexes("chief_turn_requests")
    _drop_table_with_indexes("chief_messages")
    _drop_table_with_indexes("chief_moment_snapshots")
    _drop_table_with_indexes("chief_threads")
