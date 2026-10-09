"""Timestamped SQLite snapshots taken at startup.

``dolphin_tasks.db`` holds the operator's real projects and tasks and had no
copies at all. A single bad migration, a truncating write, or a disk fault
would have lost it with nothing to restore from.

Two details that matter more than they look:

* **The online backup API, not a file copy.** ``shutil.copy`` on a live SQLite
  database can capture a torn page set — the copy looks fine and fails to open
  later, which is the worst possible failure mode for a backup. Python's
  ``sqlite3.Connection.backup()`` is the supported way to snapshot a database
  that may be mid-transaction, and it holds a read lock only for the copy.

* **Snapshot BEFORE ``init_db()``.** Startup is where schema changes get
  applied, so the copy has to be taken while the file is still in its previous
  known-good shape. Taking it afterwards would faithfully preserve whatever the
  migration just did to it.

Backups are best effort by design: a failure here logs and returns rather than
raising, because a machine that cannot write a snapshot must still be able to
serve. It is a safety net, not a precondition.
"""

from __future__ import annotations

import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from .observability import logger

DEFAULT_RETAINED = 10


def database_path() -> Path | None:
    """Filesystem path behind ``DATABASE_URL``, or ``None`` if not a file.

    In-memory and non-SQLite URLs have nothing to snapshot. Tests run against
    temporary databases, so this must not assume the production filename.
    """
    url = os.getenv("DATABASE_URL", "sqlite+aiosqlite:///./dolphin_tasks.db")
    if "sqlite" not in url:
        return None
    _, _, tail = url.partition(":///")
    if not tail or ":memory:" in url or tail.startswith("file:"):
        return None
    return Path(tail).expanduser().resolve()


def backup_dir() -> Path:
    configured = os.getenv("DOLPHIN_BACKUP_DIR")
    if configured:
        return Path(configured).expanduser()
    path = database_path()
    base = path.parent if path else Path.cwd()
    return base / "backups"


def retained_count() -> int:
    try:
        return max(1, int(os.getenv("DOLPHIN_BACKUP_RETAIN", DEFAULT_RETAINED)))
    except ValueError:
        return DEFAULT_RETAINED


def prune(directory: Path, keep: int) -> list[Path]:
    """Delete all but the ``keep`` newest snapshots. Returns what was removed."""
    snapshots = sorted(
        directory.glob("dolphin_tasks-*.db"),
        key=lambda item: item.name,
        reverse=True,
    )
    removed: list[Path] = []
    for stale in snapshots[keep:]:
        try:
            stale.unlink()
            removed.append(stale)
        except OSError:
            # Losing the race with another process is fine; it is already gone.
            continue
    return removed


def snapshot() -> Path | None:
    """Copy the live database to a timestamped file. Never raises."""
    source = database_path()
    if source is None or not source.exists():
        return None

    directory = backup_dir()
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    target = directory / f"dolphin_tasks-{stamp}.db"

    try:
        directory.mkdir(parents=True, exist_ok=True)
        # Read-only source handle: a snapshot must never be able to modify the
        # thing it is protecting.
        origin = sqlite3.connect(f"file:{source}?mode=ro", uri=True)
        try:
            destination = sqlite3.connect(target)
            try:
                origin.backup(destination)
            finally:
                destination.close()
        finally:
            origin.close()
    except (OSError, sqlite3.Error):
        logger.exception("Database snapshot failed; continuing without one")
        return None

    removed = prune(directory, retained_count())
    logger.info(
        "Database snapshot %s (%d bytes), pruned %d old",
        target.name,
        target.stat().st_size if target.exists() else 0,
        len(removed),
    )
    return target
