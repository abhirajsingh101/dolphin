"""project registry and signals

Revision ID: 7b6ea6689e2a
Revises: 637eb26d3286
Create Date: 2026-10-07 15:52:40.849407

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '7b6ea6689e2a'
down_revision: Union[str, Sequence[str], None] = '637eb26d3286'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Project registry, chat room classes and proactive signals."""
    # Guarded: startup's create_all may already have created these tables.
    existing = set(sa.inspect(op.get_bind()).get_table_names())

    if 'chat_rooms' not in existing:
        op.create_table('chat_rooms',
        sa.Column('chat_id', sa.String(), nullable=False),
        sa.Column('name', sa.String(), server_default='', nullable=False),
        sa.Column('room_class', sa.String(), server_default='work', nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("room_class IN ('work', 'community', 'system')", name='ck_chat_rooms_class'),
        sa.PrimaryKeyConstraint('chat_id')
        )

    if 'signal_seen_messages' not in existing:
        op.create_table('signal_seen_messages',
        sa.Column('msg_id', sa.String(), nullable=False),
        sa.Column('day', sa.String(), nullable=False),
        sa.Column('seen_at', sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint('msg_id')
        )
        with op.batch_alter_table('signal_seen_messages', schema=None) as batch_op:
            batch_op.create_index(batch_op.f('ix_signal_seen_messages_day'), ['day'], unique=False)

    if 'project_links' not in existing:
        op.create_table('project_links',
        sa.Column('id', sa.String(), nullable=False),
        sa.Column('project_id', sa.String(), nullable=False),
        sa.Column('kind', sa.String(), nullable=False),
        sa.Column('value', sa.String(), nullable=False),
        sa.Column('label', sa.String(), nullable=True),
        sa.Column('source', sa.String(), server_default='manual', nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("kind IN ('chat_room', 'person', 'alias', 'brain_page', 'repo')", name='ck_project_links_kind'),
        sa.CheckConstraint("source IN ('manual', 'learned')", name='ck_project_links_source'),
        sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('project_id', 'kind', 'value', name='uq_project_links_project_kind_value')
        )
        with op.batch_alter_table('project_links', schema=None) as batch_op:
            batch_op.create_index(batch_op.f('ix_project_links_project_id'), ['project_id'], unique=False)

    if 'signals' not in existing:
        op.create_table('signals',
        sa.Column('id', sa.String(), nullable=False),
        sa.Column('key', sa.String(), nullable=False),
        sa.Column('source', sa.String(), nullable=False),  # set by every writer
        sa.Column('lane', sa.String(), nullable=False),
        sa.Column('project_id', sa.String(), nullable=True),
        sa.Column('chat_id', sa.String(), nullable=False),
        sa.Column('room_name', sa.String(), server_default='', nullable=False),
        sa.Column('sender', sa.String(), server_default='', nullable=False),
        sa.Column('anchor_msg_id', sa.String(), nullable=False),
        sa.Column('msg_ids_json', sa.Text(), server_default='[]', nullable=False),
        sa.Column('quote', sa.Text(), nullable=False),
        sa.Column('title', sa.String(), nullable=False),
        sa.Column('why', sa.Text(), server_default='', nullable=False),
        sa.Column('plan_json', sa.Text(), server_default='[]', nullable=False),
        sa.Column('draft_reply', sa.Text(), nullable=True),
        sa.Column('confidence', sa.Float(), server_default='0', nullable=False),
        sa.Column('status', sa.String(), server_default='pending', nullable=False),
        sa.Column('replied', sa.Boolean(), server_default='0', nullable=False),
        sa.Column('task_id', sa.String(), nullable=True),
        sa.Column('feedback_reason', sa.String(), nullable=True),
        sa.Column('occurred_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("lane IN ('project', 'todo', 'opportunity')", name='ck_signals_lane'),
        sa.CheckConstraint("status IN ('pending', 'accepted', 'dismissed', 'stale')", name='ck_signals_status'),
        sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['task_id'], ['tasks.id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('key')
        )
        with op.batch_alter_table('signals', schema=None) as batch_op:
            batch_op.create_index(batch_op.f('ix_signals_project_id'), ['project_id'], unique=False)
            batch_op.create_index('ix_signals_status_occurred', ['status', 'occurred_at'], unique=False)



def downgrade() -> None:
    """Downgrade schema."""
    # ### commands auto generated by Alembic - please adjust! ###
    with op.batch_alter_table('signals', schema=None) as batch_op:
        batch_op.drop_index('ix_signals_status_occurred')
        batch_op.drop_index(batch_op.f('ix_signals_project_id'))

    op.drop_table('signals')
    with op.batch_alter_table('project_links', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_project_links_project_id'))

    op.drop_table('project_links')
    with op.batch_alter_table('signal_seen_messages', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_signal_seen_messages_day'))

    op.drop_table('signal_seen_messages')
    op.drop_table('chat_rooms')
    # ### end Alembic commands ###
