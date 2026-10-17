"""add agent exchanges

Revision ID: 92e8549e6f2b
Revises: c41d7e9a2b58
Create Date: 2026-10-16 14:11:19.977095

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '92e8549e6f2b'
down_revision: Union[str, Sequence[str], None] = 'c41d7e9a2b58'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """What was asked and answered in each agent session (app/transcript_exchanges.py)."""
    # Guarded: startup's create_all may already have created these tables.
    existing = set(sa.inspect(op.get_bind()).get_table_names())
    if 'transcript_offsets' not in existing:
        _offsets()
    if 'agent_exchanges' not in existing:
        _exchanges()


def _offsets() -> None:
    op.create_table('transcript_offsets',
    sa.Column('path', sa.Text(), nullable=False),
    sa.Column('agent', sa.String(), nullable=False),
    sa.Column('offset', sa.Integer(), server_default='0', nullable=False),
    sa.Column('size', sa.Integer(), server_default='0', nullable=False),
    sa.Column('mtime', sa.Float(), server_default='0', nullable=False),
    sa.Column('session_id', sa.String(), server_default='', nullable=False),
    sa.Column('cwd', sa.Text(), server_default='', nullable=False),
    sa.PrimaryKeyConstraint('path')
    )


def _exchanges() -> None:
    op.create_table('agent_exchanges',
    sa.Column('id', sa.String(), nullable=False),
    sa.Column('key', sa.String(), nullable=False),
    sa.Column('agent', sa.String(), nullable=False),
    sa.Column('session_id', sa.String(), nullable=False),
    sa.Column('cwd', sa.Text(), server_default='', nullable=False),
    sa.Column('folder', sa.Text(), server_default='', nullable=False),
    sa.Column('project_id', sa.String(), nullable=True),
    sa.Column('prompt', sa.Text(), server_default='', nullable=False),
    sa.Column('reply', sa.Text(), server_default='', nullable=False),
    sa.Column('started_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('finished_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ondelete='SET NULL'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('key')
    )
    with op.batch_alter_table('agent_exchanges', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_agent_exchanges_created_at'), ['created_at'], unique=False)
        batch_op.create_index(batch_op.f('ix_agent_exchanges_project_id'), ['project_id'], unique=False)


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table('agent_exchanges', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_agent_exchanges_project_id'))
        batch_op.drop_index(batch_op.f('ix_agent_exchanges_created_at'))

    op.drop_table('agent_exchanges')
    op.drop_table('transcript_offsets')
