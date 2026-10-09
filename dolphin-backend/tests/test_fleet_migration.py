"""The fleet revision on the live-startup path.

Startup runs ``create_all`` *before* migrations, so on the live database the
fleet tables already exist when revision f3537bbb1a21 runs. The revision must
treat that as a no-op instead of failing startup.
"""

from alembic import command
from sqlalchemy import create_engine, inspect

from app import migrations
from app.database import Base

FLEET_TABLES = {
    "fleet_missions",
    "fleet_tasks",
    "fleet_task_deps",
    "fleet_attempts",
    "fleet_events",
    "fleet_worktrees",
    "fleet_setup_approvals",
    "fleet_controls",
    "fleet_questions",
}
PREVIOUS_HEAD = "f09d7b6a2e10"
FLEET_REVISION = "f3537bbb1a21"
HEAD = "0e469321b805"


def _tables(path):
    engine = create_engine(f"sqlite:///{path}", future=True)
    try:
        return set(inspect(engine).get_table_names())
    finally:
        engine.dispose()


def _upgrade_to(path, monkeypatch, revision):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{path}")
    command.upgrade(migrations._config(), revision)


def test_fleet_revision_is_noop_when_create_all_already_made_the_tables(
    tmp_path, monkeypatch
):
    path = tmp_path / "live.db"
    # A database that predates the fleet: built and migrated to the old head.
    engine = create_engine(f"sqlite:///{path}", future=True)
    Base.metadata.create_all(engine)
    with engine.begin() as conn:
        for table in FLEET_TABLES:
            conn.exec_driver_sql(f"DROP TABLE IF EXISTS {table}")
    engine.dispose()
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{path}")
    command.stamp(migrations._config(), PREVIOUS_HEAD)

    # The next startup: create_all adds the fleet tables, then migrations run.
    engine = create_engine(f"sqlite:///{path}", future=True)
    Base.metadata.create_all(engine)
    engine.dispose()
    assert FLEET_TABLES <= _tables(path)

    landed = migrations.upgrade()
    assert landed == HEAD


def test_fleet_revision_round_trips(tmp_path, monkeypatch):
    path = tmp_path / "roundtrip.db"
    engine = create_engine(f"sqlite:///{path}", future=True)
    Base.metadata.create_all(engine)
    with engine.begin() as conn:
        for table in FLEET_TABLES:
            conn.exec_driver_sql(f"DROP TABLE IF EXISTS {table}")
    engine.dispose()
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{path}")
    command.stamp(migrations._config(), PREVIOUS_HEAD)

    _upgrade_to(path, monkeypatch, HEAD)
    assert FLEET_TABLES <= _tables(path)
    command.downgrade(migrations._config(), PREVIOUS_HEAD)
    assert not (FLEET_TABLES & _tables(path))
    _upgrade_to(path, monkeypatch, HEAD)
    assert FLEET_TABLES <= _tables(path)
