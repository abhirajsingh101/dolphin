"""durable Dolphin agent tool receipts"""
from alembic import op
import sqlalchemy as sa
revision = 'f09d7b6a2e10'
down_revision = 'e8b2c61d9f04'
branch_labels = None
depends_on = None


def upgrade():
    # Startup creates missing mapped tables before migrations; support both paths.
    if 'dolphin_tool_runs' not in sa.inspect(op.get_bind()).get_table_names():
        op.create_table('dolphin_tool_runs', sa.Column('id', sa.String(), primary_key=True),
            sa.Column('turn_id', sa.String(), nullable=False), sa.Column('tool', sa.String(), nullable=False),
            sa.Column('arguments_json', sa.Text(), nullable=False), sa.Column('status', sa.String(), nullable=False),
            sa.Column('result_json', sa.Text()), sa.Column('created_at', sa.DateTime(timezone=True), nullable=False))
    if 'ix_dolphin_tool_runs_turn_id' not in {i['name'] for i in sa.inspect(op.get_bind()).get_indexes('dolphin_tool_runs')}:
        op.create_index('ix_dolphin_tool_runs_turn_id', 'dolphin_tool_runs', ['turn_id'])


def downgrade():
    op.drop_table('dolphin_tool_runs')
