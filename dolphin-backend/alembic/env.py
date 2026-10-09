"""Alembic environment for Dolphin Tasks.

Two things differ from the generated template:

* **The URL comes from ``DATABASE_URL``, not alembic.ini**, so migrations run
  against exactly the database the app runs against, including in tests and on
  a machine that overrides it. The async driver is stripped: Alembic here runs
  synchronously, and ``sqlite+aiosqlite://`` cannot be opened by a sync engine.

* **``render_as_batch=True``.** SQLite has no real ``ALTER COLUMN`` or
  ``DROP COLUMN`` before 3.35, so any non-additive change has to be done by the
  copy-and-rename dance. Batch mode makes Alembic emit that automatically.
  Without it, the first migration that alters a column fails on SQLite — which
  is precisely the class of change the hand-rolled additive block in
  ``database.py`` could never express, and the reason this exists.
"""

from logging.config import fileConfig
import os
import sys
from pathlib import Path

from sqlalchemy import engine_from_config, pool

from alembic import context

# The app package sits one level above this directory.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# Resolve the URL BEFORE importing the app. `app.database` builds an async
# engine at import time, so a synchronous DATABASE_URL (which is what Alembic
# needs) makes that import raise "The asyncio extension requires an async
# driver". Capture the sync form for Alembic, then hand the app back an async
# form purely so its module-level engine can be constructed.
_RAW_URL = os.getenv("DATABASE_URL", "sqlite+aiosqlite:///./dolphin_tasks.db")
_SYNC_URL = _RAW_URL.replace("+aiosqlite", "").replace("+asyncpg", "")
if _RAW_URL.startswith("sqlite:"):
    os.environ["DATABASE_URL"] = _RAW_URL.replace("sqlite:", "sqlite+aiosqlite:", 1)

from app.database import Base  # noqa: E402
from app import models  # noqa: E402,F401  (import registers the tables on Base)

config = context.config

if config.config_file_name is not None:
    # disable_existing_loggers=False is load-bearing, not tidiness. Migrations
    # run in-process at startup (app/migrations.py), and fileConfig's default
    # of True disables every logger not named in alembic.ini — including
    # "dolphin", which carries all request and error logging. Leaving the
    # default in place silently switched observability off the moment
    # migrations ran, and the only reason it was caught is that the
    # observability tests passed alone and failed in the full suite.
    fileConfig(config.config_file_name, disable_existing_loggers=False)

target_metadata = Base.metadata


def database_url() -> str:
    """The app's URL, converted to a synchronous driver."""
    return _SYNC_URL


def compare_type(context, inspected_column, metadata_column, inspected_type, metadata_type):
    """Treat SQLite TEXT and SQLAlchemy String as the same type.

    Columns added by the old hand-rolled block in ``database.py`` were declared
    ``TEXT``; ``models.py`` declares them ``String()``. SQLite has one text
    storage class, so these are identical on disk — but Alembic compares the
    declared types and reported eleven phantom ``modify_type`` operations,
    which would have buried the two REAL findings (missing indexes) in noise
    and produced a migration that rewrites tables for no reason.

    Returning ``None`` defers to Alembic's default comparison for every other
    pair, so genuine type changes are still caught.
    """
    text_like = {"TEXT", "VARCHAR", "STRING"}
    inspected = inspected_type.__class__.__name__.upper()
    declared = metadata_type.__class__.__name__.upper()
    if inspected in text_like and declared in text_like:
        # Only equivalent when neither side pins a length the other lacks.
        if getattr(inspected_type, "length", None) == getattr(metadata_type, "length", None):
            return False
    return None


def run_migrations_offline() -> None:
    context.configure(
        url=database_url(),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        render_as_batch=True,
        compare_type=compare_type,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    section = config.get_section(config.config_ini_section, {})
    section["sqlalchemy.url"] = database_url()

    connectable = engine_from_config(
        section, prefix="sqlalchemy.", poolclass=pool.NullPool
    )

    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            render_as_batch=True,
            compare_type=compare_type,
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
