"""add task created_in_session

Revision ID: 0c122761af16
Revises: 92e8549e6f2b
Create Date: 2026-11-13 19:58:14.242034

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '0c122761af16'
down_revision: Union[str, Sequence[str], None] = '92e8549e6f2b'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """The tmux session that was selected when a todo was added.

    Startup runs create_all before migrations, so the column may already
    exist on a fresh database; the step checks first."""
    columns = {column["name"] for column in sa.inspect(op.get_bind()).get_columns("tasks")}
    if "created_in_session" not in columns:
        with op.batch_alter_table('tasks', schema=None) as batch_op:
            batch_op.add_column(sa.Column('created_in_session', sa.String(), nullable=True))



def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table('tasks', schema=None) as batch_op:
        batch_op.drop_column('created_in_session')

