from __future__ import annotations

import sqlite3

from app.database import enable_sqlite_foreign_keys


def test_production_sqlite_connect_hook_enables_foreign_keys():
    connection = sqlite3.connect(":memory:")
    try:
        assert connection.execute("PRAGMA foreign_keys").fetchone()[0] == 0
        enable_sqlite_foreign_keys(connection, None)
        assert connection.execute("PRAGMA foreign_keys").fetchone()[0] == 1
    finally:
        connection.close()
