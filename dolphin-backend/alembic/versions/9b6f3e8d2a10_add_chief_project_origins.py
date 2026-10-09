"""add immutable Chief project snapshot origins

Revision ID: 9b6f3e8d2a10
Revises: c7c7f07a1b1e
Create Date: 2026-08-12 13:30:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "9b6f3e8d2a10"
down_revision: Union[str, Sequence[str], None] = "c7c7f07a1b1e"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _inspector():
    return sa.inspect(op.get_bind())


def _index_names(table_name: str) -> set[str]:
    return {item["name"] for item in _inspector().get_indexes(table_name)}


def _check_names(table_name: str) -> set[str]:
    return {
        item["name"]
        for item in _inspector().get_check_constraints(table_name)
        if item.get("name")
    }


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
    """Add conversation-owned safe project origins, never activity cache data."""

    columns = {item["name"] for item in _inspector().get_columns("chief_threads")}
    checks = _check_names("chief_threads")
    if (
        "project_fingerprint" not in columns
        or "ck_chief_threads_single_origin" not in checks
    ):
        with op.batch_alter_table("chief_threads", recreate="always") as batch_op:
            if "project_fingerprint" not in columns:
                batch_op.add_column(
                    sa.Column("project_fingerprint", sa.String(), nullable=True)
                )
            if "ck_chief_threads_single_origin" not in checks:
                batch_op.create_check_constraint(
                    "ck_chief_threads_single_origin",
                    "moment_fingerprint IS NULL OR project_fingerprint IS NULL",
                )
    _create_index_if_missing(
        "uq_chief_threads_project_fingerprint",
        "chief_threads",
        ["project_fingerprint"],
        unique=True,
    )

    if "chief_project_snapshots" not in _inspector().get_table_names():
        op.create_table(
            "chief_project_snapshots",
            sa.Column("id", sa.String(), nullable=False),
            sa.Column("thread_id", sa.String(), nullable=False),
            sa.Column("fingerprint", sa.String(), nullable=False),
            sa.Column("schema_version", sa.String(), nullable=False),
            sa.Column("snapshot_json", sa.Text(), nullable=False),
            sa.Column("snapshot_hash", sa.String(), nullable=False),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.CheckConstraint(
                "length(snapshot_hash) = 64",
                name="ck_chief_project_snapshots_hash_length",
            ),
            sa.ForeignKeyConstraint(
                ["thread_id"],
                ["chief_threads.id"],
                ondelete="CASCADE",
            ),
            sa.PrimaryKeyConstraint("id"),
        )
    _create_index_if_missing(
        "uq_chief_project_snapshots_thread_id",
        "chief_project_snapshots",
        ["thread_id"],
        unique=True,
    )
    _create_index_if_missing(
        "uq_chief_project_snapshots_fingerprint",
        "chief_project_snapshots",
        ["fingerprint"],
        unique=True,
    )


def downgrade() -> None:
    """Remove only the Phase 8 conversation-origin extension."""

    if "chief_project_snapshots" in _inspector().get_table_names():
        for name in sorted(_index_names("chief_project_snapshots")):
            op.drop_index(name, table_name="chief_project_snapshots")
        op.drop_table("chief_project_snapshots")

    if "uq_chief_threads_project_fingerprint" in _index_names("chief_threads"):
        op.drop_index(
            "uq_chief_threads_project_fingerprint",
            table_name="chief_threads",
        )
    columns = {item["name"] for item in _inspector().get_columns("chief_threads")}
    checks = _check_names("chief_threads")
    if (
        "project_fingerprint" in columns
        or "ck_chief_threads_single_origin" in checks
    ):
        with op.batch_alter_table("chief_threads", recreate="always") as batch_op:
            if "ck_chief_threads_single_origin" in checks:
                batch_op.drop_constraint(
                    "ck_chief_threads_single_origin",
                    type_="check",
                )
            if "project_fingerprint" in columns:
                batch_op.drop_column("project_fingerprint")
