"""Guards for app/backup.py.

A backup system fails in two directions and both are silent: it can produce
files that cannot be restored, or it can take the API down when the disk it
writes to goes away. Every test here targets one of those.
"""

import sqlite3

import pytest

from app import backup


def _make_db(path, rows=("alpha", "beta")):
    connection = sqlite3.connect(path)
    connection.execute("CREATE TABLE tasks (id INTEGER PRIMARY KEY, title TEXT)")
    connection.executemany(
        "INSERT INTO tasks (title) VALUES (?)", [(row,) for row in rows]
    )
    connection.commit()
    connection.close()


@pytest.fixture
def live_db(tmp_path, monkeypatch):
    source = tmp_path / "dolphin_tasks.db"
    _make_db(source)
    monkeypatch.setenv("DATABASE_URL", f"sqlite+aiosqlite:///{source}")
    monkeypatch.setenv("DOLPHIN_BACKUP_DIR", str(tmp_path / "backups"))
    return source


def test_snapshot_is_a_restorable_database_not_just_a_file(live_db):
    """The whole point: the copy must open and hold the same rows."""
    target = backup.snapshot()

    assert target is not None and target.exists()

    restored = sqlite3.connect(target)
    try:
        titles = [row[0] for row in restored.execute("SELECT title FROM tasks")]
    finally:
        restored.close()
    assert titles == ["alpha", "beta"]


def test_snapshot_captures_data_written_while_a_connection_is_open(live_db):
    """The online backup API exists precisely to handle a live database.

    A plain file copy of a database with an open writer can capture a torn
    page set that opens as 'database disk image is malformed'.
    """
    holder = sqlite3.connect(live_db)
    holder.execute("INSERT INTO tasks (title) VALUES ('gamma')")
    holder.commit()
    try:
        target = backup.snapshot()
    finally:
        holder.close()

    restored = sqlite3.connect(target)
    try:
        titles = [row[0] for row in restored.execute("SELECT title FROM tasks")]
        # An intact copy also passes SQLite's own consistency check.
        assert restored.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    finally:
        restored.close()
    assert titles == ["alpha", "beta", "gamma"]


def test_the_source_database_is_opened_read_only(live_db, monkeypatch):
    """A backup must not be able to modify the thing it is protecting."""
    opened: list[str] = []
    real_connect = sqlite3.connect

    def recording_connect(target, *args, **kwargs):
        opened.append(str(target))
        return real_connect(target, *args, **kwargs)

    monkeypatch.setattr(backup.sqlite3, "connect", recording_connect)
    backup.snapshot()

    source_opens = [item for item in opened if str(live_db) in item]
    assert source_opens, "expected the source database to be opened"
    assert all("mode=ro" in item for item in source_opens)


def test_retention_keeps_the_newest_and_deletes_the_rest(tmp_path, monkeypatch):
    directory = tmp_path / "backups"
    directory.mkdir()
    # Names sort chronologically because the stamp is fixed-width UTC.
    names = [f"dolphin_tasks-2026080{index}T000000Z.db" for index in range(1, 8)]
    for name in names:
        (directory / name).write_text("x", encoding="utf-8")

    removed = backup.prune(directory, keep=3)

    surviving = sorted(item.name for item in directory.glob("dolphin_tasks-*.db"))
    assert surviving == names[-3:]
    assert len(removed) == 4


def test_snapshot_is_a_no_op_when_there_is_no_database_yet(tmp_path, monkeypatch):
    """First ever boot must not fail because there is nothing to copy."""
    monkeypatch.setenv(
        "DATABASE_URL", f"sqlite+aiosqlite:///{tmp_path / 'absent.db'}"
    )
    monkeypatch.setenv("DOLPHIN_BACKUP_DIR", str(tmp_path / "backups"))

    assert backup.snapshot() is None


def test_in_memory_databases_are_skipped(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
    assert backup.database_path() is None
    assert backup.snapshot() is None


def test_an_unwritable_backup_directory_does_not_raise(live_db, monkeypatch, tmp_path):
    """Startup must survive a missing or read-only backup volume."""
    blocker = tmp_path / "not-a-dir"
    blocker.write_text("", encoding="utf-8")
    monkeypatch.setenv("DOLPHIN_BACKUP_DIR", str(blocker / "backups"))

    assert backup.snapshot() is None


def test_retention_count_falls_back_on_a_bad_env_value(monkeypatch):
    monkeypatch.setenv("DOLPHIN_BACKUP_RETAIN", "not-a-number")
    assert backup.retained_count() == backup.DEFAULT_RETAINED

    monkeypatch.setenv("DOLPHIN_BACKUP_RETAIN", "0")
    # Zero would mean "delete every snapshot you just took".
    assert backup.retained_count() == 1
