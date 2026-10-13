"""The session_links table and Project.is_hidden: migration and cascades."""

from __future__ import annotations

import sqlite3

from alembic import command
from sqlalchemy import create_engine, inspect

from app import migrations

PREVIOUS_HEAD = "0e469321b805"


def test_migration_adds_session_links_and_hidden_projects(tmp_path, monkeypatch):
    path = tmp_path / "upgrade.db"
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{path}")
    config = migrations._config()
    command.upgrade(config, PREVIOUS_HEAD)
    raw = sqlite3.connect(path)
    raw.execute("INSERT INTO projects (id, name, emoji, color, path, is_inbox, position, serial_queue_status, created_at, updated_at) "
                "VALUES ('p1', 'Kept', '', '#6B7280', '/tmp/kept', 0, 0, 'idle', '2026-10-12', '2026-10-12')")
    raw.commit()
    raw.close()

    assert migrations.upgrade() == "c41d7e9a2b58"

    engine = create_engine(f"sqlite:///{path}", future=True)
    try:
        inspector = inspect(engine)
        assert "session_links" in inspector.get_table_names()
        columns = {c["name"] for c in inspector.get_columns("session_links")}
        assert columns == {"session_name", "project_id", "task_id", "agent", "worktree_path", "branch",
                           "base_ref", "base_sha", "created_at", "archived_at"}
        assert "is_hidden" in {c["name"] for c in inspector.get_columns("projects")}
        with engine.connect() as connection:
            assert connection.exec_driver_sql("SELECT is_hidden FROM projects WHERE id='p1'").scalar() == 0
    finally:
        engine.dispose()


def test_links_follow_their_project_and_outlive_their_todo(tmp_path, monkeypatch):
    path = tmp_path / "cascade.db"
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{path}")
    migrations.upgrade()
    raw = sqlite3.connect(path)
    raw.execute("PRAGMA foreign_keys=ON")
    raw.execute("INSERT INTO projects (id, name, emoji, color, is_inbox, position, serial_queue_status, is_hidden) "
                "VALUES ('p', 'P', '', '#6B7280', 0, 0, 'idle', 0)")
    raw.execute("INSERT INTO tasks (id, project_id, title, origin, execution_prompt) VALUES ('t', 'p', 'Todo', 'human', '')")
    raw.execute("INSERT INTO session_links (session_name, project_id, task_id, created_at) VALUES ('s-dolphin', 'p', 't', '2026-10-12')")
    raw.execute("DELETE FROM tasks WHERE id='t'")
    assert raw.execute("SELECT task_id FROM session_links").fetchone() == (None,)
    raw.execute("DELETE FROM projects WHERE id='p'")
    assert raw.execute("SELECT count(*) FROM session_links").fetchone() == (0,)
    raw.close()
