"""The suite must never run against a database anyone cares about.

Measured on 2026-08-13, before tests/conftest.py grew its guard: one clean
`cd dolphin-backend && python -m pytest tests -q` created a 233KB
`dolphin-backend/dolphin_tasks.db` in the working directory, because
`app/database.py` defaults DATABASE_URL to a *relative* sqlite path and app
startup runs Alembic migrations against whatever that resolves to. Run from the
operator's checkout, that is the live database.

The guard itself is a `pytest_configure` hook, so it has already run and cannot
be re-entered from inside a test. These tests therefore do two things it can
still prove: they exercise the predicate the hook decides with, and they assert
the outcome the hook produced for this very session.
"""

import os
from pathlib import Path

import pytest

from tests.conftest import (
    PRODUCTION_DB_NAME,
    REPO_ROOT,
    live_database_reason,
    sqlite_file_for,
)


def test_the_dangerous_default_is_refused() -> None:
    """The URL app/database.py falls back to when nothing is configured."""
    reason = live_database_reason(f"sqlite+aiosqlite:///./{PRODUCTION_DB_NAME}")

    assert reason is not None
    assert PRODUCTION_DB_NAME in reason


def test_another_checkouts_database_is_refused() -> None:
    """A worktree can be pointed at the main checkout's database.

    That path is outside this repo root, which is why the filename check exists
    alongside the containment check rather than instead of it. This is the exact
    file systemd/user/dolphin-backend.service names.
    """
    url = (
        "sqlite+aiosqlite:////srv/dolphin-tasks/"
        f"dolphin-backend/{PRODUCTION_DB_NAME}"
    )

    reason = live_database_reason(url)

    assert reason is not None
    assert "/srv/dolphin-tasks" in reason


def test_a_scratch_database_inside_the_repo_is_refused(tmp_path: Path) -> None:
    """Containment, not just the filename: nothing in the tree is a target."""
    reason = live_database_reason(f"sqlite+aiosqlite:///{REPO_ROOT}/scratch.db")

    assert reason is not None
    assert str(REPO_ROOT) in reason


def test_a_throwaway_database_is_allowed(tmp_path: Path) -> None:
    """The guard refuses live databases; it must not refuse ordinary use."""
    assert live_database_reason(f"sqlite+aiosqlite:///{tmp_path}/scratch.db") is None
    assert live_database_reason("sqlite+aiosqlite:///:memory:") is None
    assert live_database_reason("postgresql://localhost/anything") is None


def test_sqlite_file_resolution_matches_app_backup(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The reading of DATABASE_URL is shared with the code being guarded.

    If app.backup and this guard ever disagree about which file a URL names,
    the guard is protecting a different file than the one being written.
    """
    from app import backup

    url = f"sqlite+aiosqlite:///{tmp_path}/somewhere.db"
    monkeypatch.setenv("DATABASE_URL", url)

    assert sqlite_file_for(url) == backup.database_path()


def test_this_session_is_not_pointed_at_a_live_database() -> None:
    """The outcome, not the predicate: prove the hook actually took effect.

    This is the assertion that fails if someone deletes the guard, because
    without it an unset DATABASE_URL leaves app/database.py on its relative
    default and this session is writing to ./dolphin_tasks.db.
    """
    from app import database

    assert live_database_reason(database.DATABASE_URL) is None, (
        f"the running session is bound to {database.DATABASE_URL}"
    )
    assert os.environ["DATABASE_URL"] == database.DATABASE_URL, (
        "app.database read a different URL than the environment now holds, "
        "which means the guard ran after the module was imported"
    )
