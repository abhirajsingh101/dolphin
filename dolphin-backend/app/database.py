from sqlalchemy import event, text
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy.orm import DeclarativeBase
import os

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite+aiosqlite:///./dolphin_tasks.db")

engine = create_async_engine(DATABASE_URL, echo=False)
async_session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


def enable_sqlite_foreign_keys(dbapi_connection, _connection_record) -> None:
    """Enable SQLite FK enforcement for every production connection."""

    cursor = dbapi_connection.cursor()
    try:
        cursor.execute("PRAGMA foreign_keys=ON")
        # Wait for a busy writer instead of failing after the driver's 5 s
        # default: the fleet's hook, watchdog and scheduler writes are short but
        # frequent, and a burst of them must queue rather than error.
        cursor.execute("PRAGMA busy_timeout=30000")
    finally:
        cursor.close()


if DATABASE_URL.startswith("sqlite"):
    event.listen(engine.sync_engine, "connect", enable_sqlite_foreign_keys)


class Base(DeclarativeBase):
    pass


async def get_db():
    async with async_session() as session:
        yield session


async def init_db():
    """Create missing tables and apply the frozen legacy column additions.

    FROZEN: do not add entries to the two dictionaries below. They exist only
    to bring a pre-Alembic database up to the baseline revision; every schema
    change from here on gets an Alembic migration (see app/migrations.py).

    The reason is concrete. This block can only express "add a nullable column
    to one of two tables" — it cannot create an index, so `index=True` on
    projects.serial_queue_id and task_workflows.serial_queue_id was declared in
    models.py and silently never applied to the live database.
    """
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        if conn.dialect.name == "sqlite":
            workflow_result = await conn.execute(
                text("PRAGMA table_info(task_workflows)")
            )
            workflow_existing = {
                str(row[1]) for row in workflow_result.fetchall()
            }
            workflow_additive_columns = {
                "placement_kind": "TEXT",
                "placement_project_id": "TEXT",
                "placement_project_name": "TEXT",
                "placement_workspace_path": "TEXT",
                "placement_reason": "TEXT",
                "placement_confidence": "INTEGER",
                "placement_generated_at": "DATETIME",
                "source_project_id": "TEXT",
                "cleanup_status": (
                    "TEXT NOT NULL DEFAULT 'not_applicable'"
                ),
                "cleanup_error": "TEXT",
                "cleanup_archive_path": "TEXT",
                "cleanup_completed_at": "DATETIME",
                "serial_queue_id": "TEXT",
                "serial_queue_position": "INTEGER",
                "serial_queue_status": (
                    "TEXT NOT NULL DEFAULT 'not_queued'"
                ),
                "serial_queue_error": "TEXT",
                "serial_queue_enqueued_at": "DATETIME",
                "serial_queue_started_at": "DATETIME",
                "serial_queue_completed_at": "DATETIME",
            }
            for column, definition in workflow_additive_columns.items():
                if column not in workflow_existing:
                    await conn.execute(
                        text(
                            f"ALTER TABLE task_workflows "
                            f"ADD COLUMN {column} {definition}"
                        )
                    )

            project_result = await conn.execute(
                text("PRAGMA table_info(projects)")
            )
            project_existing = {
                str(row[1]) for row in project_result.fetchall()
            }
            project_additive_columns = {
                "serial_queue_id": "TEXT",
                "serial_queue_status": "TEXT NOT NULL DEFAULT 'idle'",
                "serial_queue_session_name": "TEXT",
                "serial_queue_error": "TEXT",
                "serial_queue_created_at": "DATETIME",
                "serial_queue_updated_at": "DATETIME",
            }
            for column, definition in project_additive_columns.items():
                if column not in project_existing:
                    await conn.execute(
                        text(
                            f"ALTER TABLE projects "
                            f"ADD COLUMN {column} {definition}"
                        )
                    )
