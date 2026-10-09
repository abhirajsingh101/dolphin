"""Test-session isolation: the live log and the live database.

Both entries here are real fixes rather than tidiness. Each one stops the suite
from writing to a file the running backend owns.

``app.observability`` writes to ``logs/backend.log`` — the production log the
running backend uses. Tests import it transitively (``app.backup`` and
``app.migrations`` both log), so a test run appended into the live log: 8KB
temp-database snapshots, a deliberately-failed snapshot with a full traceback,
and three "Stamping unversioned database" lines from throwaway databases.

That is not cosmetic. The whole point of adding request logging was to have
somewhere trustworthy to look when something breaks in production, and a log
seeded with fabricated failures from a test run is worse than no log — it will
send someone chasing an incident that never happened.

The database is the same class of mistake with worse consequences, and it is
handled in ``pytest_configure`` rather than in a fixture — see the comment
there for why the timing is forced.
"""

import logging
import os
import shutil
from pathlib import Path

import pytest
from _pytest.tmpdir import TempPathFactory

# tests/ -> dolphin-backend/ -> the checkout root.
REPO_ROOT = Path(__file__).resolve().parents[2]

# The filename every real Dolphin database has: the code's default, the one in
# systemd/user/dolphin-backend.service, and the one in every worktree.
PRODUCTION_DB_NAME = "dolphin_tasks.db"

# Where the session's own scratch database lives, so pytest_unconfigure can
# remove it and the snapshots app.backup writes beside it.
_SCRATCH_DIR = pytest.StashKey[Path]()


def sqlite_file_for(url: str) -> Path | None:
    """Filesystem path behind a ``DATABASE_URL``, or ``None`` if it has none.

    Deliberately the same reading as ``app.backup.database_path`` — including
    ``Path(...).resolve()``, which is where the whole problem comes from: the
    default URL is *relative*, so it names whatever database happens to sit in
    the current working directory.
    """
    if "sqlite" not in url:
        return None
    _, _, tail = url.partition(":///")
    if not tail or ":memory:" in url or tail.startswith("file:"):
        return None
    return Path(tail).expanduser().resolve()


def live_database_reason(url: str) -> str | None:
    """Why ``url`` must not be used by a test run, or ``None`` if it is safe.

    Two ways a URL is disqualified, and the second is not redundant: a worktree
    checked out under /data can still be pointed at the main checkout's
    database, which is outside *this* repo root but is exactly the file we are
    protecting.
    """
    path = sqlite_file_for(url)
    if path is None:
        return None
    if path.name == PRODUCTION_DB_NAME:
        return f"{path} is a real Dolphin database (the production filename)"
    if path.is_relative_to(REPO_ROOT):
        return f"{path} is inside the repository at {REPO_ROOT}"
    return None


def pytest_configure(config: pytest.Config) -> None:
    """Guarantee the session runs against a throwaway database.

    Running the suite from a checkout with DATABASE_URL unset resolves the
    default ``sqlite+aiosqlite:///./dolphin_tasks.db`` against the current
    working directory, so ``cd dolphin-backend && pytest`` runs app startup —
    and therefore Alembic migrations — against the operator's real database.
    Measured on 2026-08-13 before this guard existed: one clean run of
    `pytest tests -q` created a 233KB ``dolphin-backend/dolphin_tasks.db``.
    It has already cost one confusing debugging session, when the live database
    was stamped at a migration from another branch and the suite failed on it.

    This is a ``pytest_configure`` hook and not an autouse session fixture,
    which is the shape the log isolation above uses, because a fixture runs too
    late. ``app/database.py`` reads DATABASE_URL and builds its engine at import
    time, ``app/main.py`` and other modules then do
    ``from .database import async_session``, and 36 test modules import from
    ``app.database`` at module scope — all during collection, which finishes
    before the first fixture runs. Rebinding the module attribute afterwards
    would not reach the modules that already hold a reference to the old
    session factory. Setting the environment variable before collection reaches
    everything, because everything reads it through ``os.getenv``.

    An explicitly-set DATABASE_URL is never silently redirected. An operator who
    set it deserves to be told it was refused and why; quietly ignoring it would
    mean the next person to point the suite at a database on purpose spends an
    afternoon wondering why nothing lands in it.
    """
    # The fleet's default hook socket and state dir belong to the running
    # backend, exactly like its database. A test that starts the app must never
    # unlink and rebind the live fleet hook socket, whatever DATABASE_URL says.
    fleet_dir = TempPathFactory.from_config(config, _ispytest=True).mktemp("fleet")
    os.environ.setdefault("DOLPHIN_FLEET_HOOK_SOCKET", str(fleet_dir / "fleet-hook.sock"))
    os.environ.setdefault("DOLPHIN_FLEET_STATE_DIR", str(fleet_dir / "fleet-state"))
    # Never call a real model from the suite: the reviewer and the permission
    # gate are exercised through injected stubs where a test needs them.
    os.environ.setdefault("DOLPHIN_FLEET_REVIEWER", "off")
    os.environ.setdefault("DOLPHIN_FLEET_BRAIN", "off")  # never the real brain from tests
    os.environ.setdefault("DOLPHIN_FLEET_GATE", "off")

    configured = os.environ.get("DATABASE_URL")

    if configured:
        reason = live_database_reason(configured)
        if reason is None:
            return
        raise pytest.UsageError(
            f"DATABASE_URL refuses to run the test suite: {reason}.\n"
            "The suite runs app startup, which runs Alembic migrations, so "
            "this run would migrate that file.\n"
            "Point DATABASE_URL at a scratch file instead, for example:\n"
            "    DATABASE_URL=sqlite+aiosqlite:///$(mktemp -d)/scratch.db\n"
            "or unset it entirely and the session will make its own."
        )

    # Unset is the dangerous case, because nothing about it looks dangerous.
    # `tmp_path_factory` is the same machinery the `tmp_path` fixtures use, so
    # the scratch database lands beside them under pytest's basetemp and is
    # cleaned up on the same rotation.
    scratch_dir = TempPathFactory.from_config(config, _ispytest=True).mktemp(
        "database"
    )
    os.environ["DATABASE_URL"] = f"sqlite+aiosqlite:///{scratch_dir}/scratch.db"
    config.stash[_SCRATCH_DIR] = scratch_dir


def pytest_unconfigure(config: pytest.Config) -> None:
    """Drop the scratch database, and the snapshots app.backup wrote next to it."""
    scratch_dir = config.stash.get(_SCRATCH_DIR, None)
    if scratch_dir is not None:
        shutil.rmtree(scratch_dir, ignore_errors=True)
        os.environ.pop("DATABASE_URL", None)


@pytest.fixture(autouse=True, scope="session")
def isolate_logs(tmp_path_factory):
    """Point the dolphin logger at a throwaway directory for the whole session."""
    from app import observability

    log_dir = tmp_path_factory.mktemp("logs")

    original_dir = observability.LOG_DIR
    original_file = observability.LOG_FILE
    observability.LOG_DIR = log_dir
    observability.LOG_FILE = log_dir / "backend.log"

    logger = observability.logger
    original_handlers = list(logger.handlers)
    for handler in original_handlers:
        logger.removeHandler(handler)
    # A null handler keeps `logger.exception(...)` calls in the code under test
    # from falling back to stderr and drowning pytest output.
    logger.addHandler(logging.NullHandler())

    yield log_dir

    for handler in list(logger.handlers):
        logger.removeHandler(handler)
    for handler in original_handlers:
        logger.addHandler(handler)
    observability.LOG_DIR = original_dir
    observability.LOG_FILE = original_file
