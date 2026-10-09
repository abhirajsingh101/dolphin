"""fleet foundations: missions, tasks, deps, attempts, events, worktrees

Startup runs create_all before migrations, so every create is guarded, the
same way f09d7b6a2e10 does it.

Revision ID: f3537bbb1a21
Revises: f09d7b6a2e10
Create Date: 2026-09-23 11:30:49.691262

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'f3537bbb1a21'
down_revision: Union[str, Sequence[str], None] = 'f09d7b6a2e10'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _tables() -> set[str]:
    return set(sa.inspect(op.get_bind()).get_table_names())


def _indexes(table: str) -> set[str]:
    return {i["name"] for i in sa.inspect(op.get_bind()).get_indexes(table)}


def _create_table(name, *columns, **kw):
    if name not in _tables():
        op.create_table(name, *columns, **kw)


def upgrade() -> None:
    """Upgrade schema."""
    _create_table('fleet_setup_approvals',
    sa.Column('repo_path', sa.Text(), nullable=False),
    sa.Column('setup_hash', sa.String(), nullable=False),
    sa.Column('commands_json', sa.Text(), nullable=False),
    sa.Column('approved_at', sa.DateTime(timezone=True), nullable=False),
    sa.PrimaryKeyConstraint('repo_path', 'setup_hash')
    )
    _create_table('fleet_missions',
    sa.Column('id', sa.String(), nullable=False),
    sa.Column('project_id', sa.String(), nullable=False),
    sa.Column('title', sa.String(), nullable=False),
    sa.Column('objective', sa.Text(), nullable=False),
    sa.Column('success_criteria', sa.Text(), nullable=True),
    sa.Column('autonomy_level', sa.Integer(), server_default='2', nullable=False),
    sa.Column('state', sa.String(), server_default='draft', nullable=False),
    sa.Column('repo_path', sa.Text(), nullable=False),
    sa.Column('base_ref', sa.String(), nullable=True),
    sa.Column('base_sha', sa.String(), nullable=True),
    sa.Column('integration_branch', sa.String(), nullable=True),
    sa.Column('budget_usd', sa.Integer(), nullable=True),
    sa.Column('budget_minutes', sa.Integer(), nullable=True),
    sa.Column('created_by', sa.String(), server_default='human', nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.CheckConstraint("state IN ('draft', 'planning', 'running', 'integrating', 'ready_to_ship', 'shipped', 'failed', 'cancelled', 'paused')", name='ck_fleet_missions_state'),
    sa.CheckConstraint('autonomy_level BETWEEN 1 AND 4', name='ck_fleet_missions_autonomy_level'),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    if 'ix_fleet_missions_project_id' not in _indexes('fleet_missions'):
        op.create_index('ix_fleet_missions_project_id', 'fleet_missions', ['project_id'], unique=False)
    if 'ix_fleet_missions_state' not in _indexes('fleet_missions'):
        op.create_index('ix_fleet_missions_state', 'fleet_missions', ['state'], unique=False)

    _create_table('fleet_worktrees',
    sa.Column('id', sa.String(), nullable=False),
    sa.Column('mission_id', sa.String(), nullable=False),
    sa.Column('attempt_id', sa.String(), nullable=True),
    sa.Column('repo_path', sa.Text(), nullable=False),
    sa.Column('path', sa.Text(), nullable=False),
    sa.Column('branch', sa.String(), nullable=False),
    sa.Column('base_sha', sa.String(), nullable=False),
    sa.Column('port', sa.Integer(), nullable=True),
    sa.Column('state', sa.String(), server_default='creating', nullable=False),
    sa.Column('setup_hash', sa.String(), nullable=True),
    sa.Column('error', sa.Text(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.CheckConstraint("state IN ('creating', 'setup_pending_approval', 'setting_up', 'active', 'setup_failed', 'removed')", name='ck_fleet_worktrees_state'),
    sa.ForeignKeyConstraint(['mission_id'], ['fleet_missions.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('path', name='uq_fleet_worktrees_path')
    )
    if 'ix_fleet_worktrees_mission_id' not in _indexes('fleet_worktrees'):
        op.create_index('ix_fleet_worktrees_mission_id', 'fleet_worktrees', ['mission_id'], unique=False)

    _create_table('fleet_tasks',
    sa.Column('id', sa.String(), nullable=False),
    sa.Column('mission_id', sa.String(), nullable=False),
    sa.Column('task_id', sa.String(), nullable=True),
    sa.Column('slug', sa.String(), nullable=False),
    sa.Column('title', sa.String(), nullable=False),
    sa.Column('role', sa.String(), server_default='implement', nullable=False),
    sa.Column('spec', sa.Text(), nullable=False),
    sa.Column('acceptance_json', sa.Text(), server_default='{}', nullable=False),
    sa.Column('owned_paths_json', sa.Text(), server_default='[]', nullable=False),
    sa.Column('agent', sa.String(), server_default='any', nullable=False),
    sa.Column('model', sa.String(), nullable=True),
    sa.Column('priority', sa.Integer(), server_default='0', nullable=False),
    sa.Column('state', sa.String(), server_default='pending', nullable=False),
    sa.Column('attempt_count', sa.Integer(), server_default='0', nullable=False),
    sa.Column('max_attempts', sa.Integer(), server_default='3', nullable=False),
    sa.Column('result_summary', sa.Text(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.CheckConstraint("role IN ('implement', 'research', 'review', 'refinery', 'verify_fix')", name='ck_fleet_tasks_role'),
    sa.CheckConstraint("state IN ('pending', 'ready', 'running', 'verifying', 'reviewing', 'merging', 'landed', 'failed', 'blocked', 'cancelled')", name='ck_fleet_tasks_state'),
    sa.ForeignKeyConstraint(['mission_id'], ['fleet_missions.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['task_id'], ['tasks.id'], ondelete='SET NULL'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('mission_id', 'slug', name='uq_fleet_tasks_mission_slug')
    )
    if 'ix_fleet_tasks_mission_id' not in _indexes('fleet_tasks'):
        op.create_index('ix_fleet_tasks_mission_id', 'fleet_tasks', ['mission_id'], unique=False)
    if 'ix_fleet_tasks_state' not in _indexes('fleet_tasks'):
        op.create_index('ix_fleet_tasks_state', 'fleet_tasks', ['state'], unique=False)

    _create_table('fleet_attempts',
    sa.Column('id', sa.String(), nullable=False),
    sa.Column('mission_id', sa.String(), nullable=False),
    sa.Column('fleet_task_id', sa.String(), nullable=False),
    sa.Column('role', sa.String(), server_default='worker', nullable=False),
    sa.Column('agent', sa.String(), nullable=False),
    sa.Column('state', sa.String(), server_default='spawning', nullable=False),
    sa.Column('capability_hash', sa.String(), nullable=False),
    sa.Column('session_name', sa.String(), nullable=True),
    sa.Column('workspace_path', sa.Text(), nullable=True),
    sa.Column('branch', sa.String(), nullable=True),
    sa.Column('base_sha', sa.String(), nullable=True),
    sa.Column('provider_session_id', sa.String(), nullable=True),
    sa.Column('pane_id', sa.String(), nullable=True),
    sa.Column('pane_pid', sa.Integer(), nullable=True),
    sa.Column('agent_pid', sa.Integer(), nullable=True),
    sa.Column('agent_start_ticks', sa.Integer(), nullable=True),
    sa.Column('trust_status', sa.String(), nullable=True),
    sa.Column('compact_count', sa.Integer(), server_default='0', nullable=False),
    sa.Column('turn_count', sa.Integer(), server_default='0', nullable=False),
    sa.Column('last_event_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('ended_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('error', sa.Text(), nullable=True),
    sa.Column('retry_of_attempt_id', sa.String(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.CheckConstraint("agent IN ('claude', 'codex', 'fake')", name='ck_fleet_attempts_agent'),
    sa.CheckConstraint("state IN ('spawning', 'started', 'ready', 'working', 'awaiting_permission', 'needs_input', 'turn_ended', 'errored', 'exited', 'start_failed', 'cancelled')", name='ck_fleet_attempts_state'),
    sa.ForeignKeyConstraint(['fleet_task_id'], ['fleet_tasks.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['mission_id'], ['fleet_missions.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    if 'ix_fleet_attempts_fleet_task_id' not in _indexes('fleet_attempts'):
        op.create_index('ix_fleet_attempts_fleet_task_id', 'fleet_attempts', ['fleet_task_id'], unique=False)
    if 'ix_fleet_attempts_mission_id' not in _indexes('fleet_attempts'):
        op.create_index('ix_fleet_attempts_mission_id', 'fleet_attempts', ['mission_id'], unique=False)
    if 'ix_fleet_attempts_session_name' not in _indexes('fleet_attempts'):
        op.create_index('ix_fleet_attempts_session_name', 'fleet_attempts', ['session_name'], unique=False)
    if 'ix_fleet_attempts_state' not in _indexes('fleet_attempts'):
        op.create_index('ix_fleet_attempts_state', 'fleet_attempts', ['state'], unique=False)

    _create_table('fleet_task_deps',
    sa.Column('task_id', sa.String(), nullable=False),
    sa.Column('depends_on_task_id', sa.String(), nullable=False),
    sa.CheckConstraint('task_id <> depends_on_task_id', name='ck_fleet_task_deps_no_self'),
    sa.ForeignKeyConstraint(['depends_on_task_id'], ['fleet_tasks.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['task_id'], ['fleet_tasks.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('task_id', 'depends_on_task_id')
    )
    if 'ix_fleet_task_deps_depends_on_task_id' not in _indexes('fleet_task_deps'):
        op.create_index('ix_fleet_task_deps_depends_on_task_id', 'fleet_task_deps', ['depends_on_task_id'], unique=False)

    _create_table('fleet_events',
    sa.Column('seq', sa.Integer(), autoincrement=True, nullable=False),
    sa.Column('event_id', sa.String(), nullable=True),
    sa.Column('mission_id', sa.String(), nullable=False),
    sa.Column('attempt_id', sa.String(), nullable=True),
    sa.Column('type', sa.String(), nullable=False),
    sa.Column('source', sa.String(), nullable=False),
    sa.Column('payload_json', sa.Text(), server_default='{}', nullable=False),
    sa.Column('emitted_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['attempt_id'], ['fleet_attempts.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['mission_id'], ['fleet_missions.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('seq'),
    sa.UniqueConstraint('event_id', name='uq_fleet_events_event_id')
    )
    if 'ix_fleet_events_attempt_id' not in _indexes('fleet_events'):
        op.create_index('ix_fleet_events_attempt_id', 'fleet_events', ['attempt_id'], unique=False)
    if 'ix_fleet_events_mission_id' not in _indexes('fleet_events'):
        op.create_index('ix_fleet_events_mission_id', 'fleet_events', ['mission_id'], unique=False)



def downgrade() -> None:
    """Downgrade schema."""
    # ### commands auto generated by Alembic - please adjust! ###
    with op.batch_alter_table('fleet_events', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_fleet_events_mission_id'))
        batch_op.drop_index(batch_op.f('ix_fleet_events_attempt_id'))

    op.drop_table('fleet_events')
    with op.batch_alter_table('fleet_task_deps', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_fleet_task_deps_depends_on_task_id'))

    op.drop_table('fleet_task_deps')
    with op.batch_alter_table('fleet_attempts', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_fleet_attempts_state'))
        batch_op.drop_index(batch_op.f('ix_fleet_attempts_session_name'))
        batch_op.drop_index(batch_op.f('ix_fleet_attempts_mission_id'))
        batch_op.drop_index(batch_op.f('ix_fleet_attempts_fleet_task_id'))

    op.drop_table('fleet_attempts')
    with op.batch_alter_table('fleet_tasks', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_fleet_tasks_state'))
        batch_op.drop_index(batch_op.f('ix_fleet_tasks_mission_id'))

    op.drop_table('fleet_tasks')
    with op.batch_alter_table('fleet_worktrees', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_fleet_worktrees_mission_id'))

    op.drop_table('fleet_worktrees')
    with op.batch_alter_table('fleet_missions', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_fleet_missions_state'))
        batch_op.drop_index(batch_op.f('ix_fleet_missions_project_id'))

    op.drop_table('fleet_missions')
    op.drop_table('fleet_setup_approvals')
