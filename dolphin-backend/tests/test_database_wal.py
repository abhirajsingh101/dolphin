"""Helper mode uses SQLite's write-ahead log, so the session scans and the bell
never wait on a writer. The long-running web install keeps its journal mode."""

import sqlite3

from app.database import enable_sqlite_foreign_keys


def test_helper_mode_turns_on_wal(tmp_path, monkeypatch):
    monkeypatch.setenv("DOLPHIN_HELPER_VERSION", "0.0.0")
    connection = sqlite3.connect(tmp_path / "helper.db")
    try:
        enable_sqlite_foreign_keys(connection, None)
        assert connection.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
        assert connection.execute("PRAGMA foreign_keys").fetchone()[0] == 1
    finally:
        connection.close()


def test_the_web_install_keeps_its_journal_mode(tmp_path, monkeypatch):
    monkeypatch.delenv("DOLPHIN_HELPER_VERSION", raising=False)
    connection = sqlite3.connect(tmp_path / "web.db")
    try:
        enable_sqlite_foreign_keys(connection, None)
        assert connection.execute("PRAGMA journal_mode").fetchone()[0] == "delete"
    finally:
        connection.close()
