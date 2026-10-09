"""Alembic migrations, applied at startup.

Why this exists, precisely: ``init_db()`` calls ``Base.metadata.create_all``,
which creates missing *tables* and never touches an existing one. To cover that
gap somebody hand-rolled an additive block that ``ALTER TABLE ... ADD COLUMN``s
a fixed dictionary of names on two tables. It works, but it can only ever
express "add a nullable column to `projects` or `task_workflows`", and every
new column has to be remembered twice — once in ``models.py`` and once in that
dict.

The cost was already paid before this module existed. ``models.py`` declares
``index=True`` on ``projects.serial_queue_id`` and
``task_workflows.serial_queue_id``; the live database had neither index,
because ``ADD COLUMN`` does not create one and nothing else was going to.
Nobody noticed, because a missing index is silent until it is slow.

Ordering at startup is deliberate and load-bearing:

1. ``backup.snapshot()`` — capture the file before anything rewrites it.
2. ``init_db()`` — ``create_all`` plus the legacy additive block, which brings
   an older database up to roughly the baseline revision.
3. ``upgrade()`` (this module) — stamp the baseline if the database has never
   been versioned, then apply everything after it.

Step 2 must precede step 3. Stamping an old database that is genuinely missing
baseline columns would assert "you are at baseline" when it is not, and the
upgrade would then skip right past the fix it needed.

The legacy block in ``database.py`` is frozen: do not add entries to it. New
schema changes get a migration.
"""

from __future__ import annotations

import os
from pathlib import Path

from alembic import command
from alembic.config import Config
from alembic.runtime.migration import MigrationContext
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine, inspect

from .observability import logger

BACKEND_ROOT = Path(__file__).resolve().parents[1]
ALEMBIC_INI = BACKEND_ROOT / "alembic.ini"


def sync_url() -> str:
    """The app's database URL with the async driver stripped.

    Alembic runs synchronously; ``sqlite+aiosqlite://`` cannot be opened by a
    sync engine.
    """
    url = os.getenv("DATABASE_URL", "sqlite+aiosqlite:///./dolphin_tasks.db")
    return url.replace("+aiosqlite", "").replace("+asyncpg", "")


def _config() -> Config:
    config = Config(str(ALEMBIC_INI))
    config.set_main_option("script_location", str(BACKEND_ROOT / "alembic"))
    config.set_main_option("sqlalchemy.url", sync_url())
    return config


def _baseline_revision(config: Config) -> str | None:
    """The first revision in the chain — what an unversioned database is at."""
    script = ScriptDirectory.from_config(config)
    bases = script.get_bases()
    return bases[0] if bases else None


def upgrade() -> str | None:
    """Bring the database to head. Returns the revision landed on.

    Raises on failure rather than swallowing it. Running against a schema that
    does not match the models is the failure this module exists to prevent, so
    booting anyway would defeat the point — and a snapshot was taken moments
    earlier, so there is something to go back to.
    """
    config = _config()
    engine = create_engine(sync_url(), future=True)

    try:
        with engine.connect() as connection:
            context = MigrationContext.configure(connection)
            current = context.get_current_revision()
            has_tables = bool(inspect(connection).get_table_names())

        if current is None and has_tables:
            # A pre-Alembic database. init_db() has already run, so its schema
            # matches the baseline; record that instead of trying to create
            # tables that exist.
            baseline = _baseline_revision(config)
            if baseline:
                logger.info("Stamping unversioned database at baseline %s", baseline)
                command.stamp(config, baseline)

        command.upgrade(config, "head")

        with engine.connect() as connection:
            landed = MigrationContext.configure(connection).get_current_revision()
    finally:
        engine.dispose()

    if landed != current:
        logger.info("Database migrated %s -> %s", current or "(unversioned)", landed)
    return landed
