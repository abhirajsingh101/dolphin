"""session links and hidden projects

Revision ID: c41d7e9a2b58
Revises: 0e469321b805
Create Date: 2026-10-12 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "c41d7e9a2b58"
down_revision: Union[str, Sequence[str], None] = "0e469321b805"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Startup runs create_all before migrations, so the table and column may
    already exist on a fresh database; each step checks first."""
    inspector = sa.inspect(op.get_bind())
    if "session_links" not in inspector.get_table_names():
        op.create_table(
            "session_links",
            sa.Column("session_name", sa.String(), nullable=False),
            sa.Column("project_id", sa.String(), nullable=False),
            sa.Column("task_id", sa.String(), nullable=True),
            sa.Column("agent", sa.String(), nullable=True),
            sa.Column("worktree_path", sa.Text(), nullable=True),
            sa.Column("branch", sa.String(), nullable=True),
            sa.Column("base_ref", sa.String(), nullable=True),
            sa.Column("base_sha", sa.String(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.Column("archived_at", sa.DateTime(), nullable=True),
            sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
            sa.ForeignKeyConstraint(["task_id"], ["tasks.id"], ondelete="SET NULL"),
            sa.PrimaryKeyConstraint("session_name"),
        )
        with op.batch_alter_table("session_links", schema=None) as batch_op:
            batch_op.create_index(batch_op.f("ix_session_links_project_id"), ["project_id"], unique=False)
            batch_op.create_index(batch_op.f("ix_session_links_task_id"), ["task_id"], unique=False)
    if "is_hidden" not in {column["name"] for column in inspector.get_columns("projects")}:
        with op.batch_alter_table("projects", schema=None) as batch_op:
            batch_op.add_column(sa.Column("is_hidden", sa.Boolean(), server_default=sa.false(), nullable=False))


def downgrade() -> None:
    with op.batch_alter_table("projects", schema=None) as batch_op:
        batch_op.drop_column("is_hidden")
    with op.batch_alter_table("session_links", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_session_links_task_id"))
        batch_op.drop_index(batch_op.f("ix_session_links_project_id"))
    op.drop_table("session_links")
