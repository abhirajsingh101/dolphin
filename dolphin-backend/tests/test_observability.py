"""Guards for app/observability.py.

The value of request logging is entirely in what it records and what it leaves
out. Both halves regress silently: a stray edit to QUIET_PATHS floods the log
with health checks until nothing else is findable, and an over-eager
``except`` in the middleware turns a 500 into a swallowed 200 that nobody
notices until a user reports missing data.
"""

import logging
from pathlib import Path

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app import observability


@pytest.fixture
def app_with_logging(tmp_path: Path, monkeypatch):
    """A minimal app carrying only the observability middleware."""
    monkeypatch.setattr(observability, "LOG_DIR", tmp_path)
    monkeypatch.setattr(observability, "LOG_FILE", tmp_path / "backend.log")

    logger = observability.logger
    original_handlers = list(logger.handlers)
    original_level = logger.level
    for handler in original_handlers:
        logger.removeHandler(handler)

    app = FastAPI()

    @app.get("/health")
    async def health():
        return {"status": "ok"}

    @app.get("/api/fine")
    async def fine():
        return {"ok": True}

    @app.get("/api/missing")
    async def missing():
        raise HTTPException(status_code=404, detail="nope")

    @app.get("/api/boom")
    async def boom():
        raise RuntimeError("detonated inside the handler")

    observability.install(app)

    yield app, tmp_path / "backend.log"

    for handler in list(logger.handlers):
        handler.close()
        logger.removeHandler(handler)
    for handler in original_handlers:
        logger.addHandler(handler)
    logger.setLevel(original_level)


def _read(log_path: Path) -> str:
    for handler in observability.logger.handlers:
        handler.flush()
    return log_path.read_text(encoding="utf-8") if log_path.exists() else ""


def test_successful_health_checks_stay_out_of_the_log(app_with_logging):
    """dolphin-status polls /health on a timer; logging it buries real traffic."""
    app, log_path = app_with_logging
    with TestClient(app) as client:
        for _ in range(5):
            assert client.get("/health").status_code == 200

    assert "/health" not in _read(log_path)


def test_ordinary_requests_are_recorded_with_id_and_duration(app_with_logging):
    app, log_path = app_with_logging
    with TestClient(app) as client:
        response = client.get("/api/fine")

    assert response.status_code == 200
    request_id = response.headers["X-Request-ID"]
    assert len(request_id) == 12

    logged = _read(log_path)
    assert f"req={request_id}" in logged
    assert "GET /api/fine -> 200" in logged
    assert "ms" in logged


def test_client_errors_are_logged_at_warning(app_with_logging):
    app, log_path = app_with_logging
    with TestClient(app) as client:
        assert client.get("/api/missing").status_code == 404

    logged = _read(log_path)
    assert "WARNING" in logged
    assert "GET /api/missing -> 404" in logged


def test_unhandled_exception_is_logged_and_returns_a_traceable_500(
    app_with_logging,
):
    """The handler must not swallow the bug: traceback to the log, id to the caller."""
    app, log_path = app_with_logging
    with TestClient(app, raise_server_exceptions=False) as client:
        response = client.get("/api/boom")

    assert response.status_code == 500
    body = response.json()
    assert body["detail"] == "Internal server error."
    request_id = body["request_id"]

    logged = _read(log_path)
    # The id the caller can quote must be the id in the log, or the whole
    # scheme is decorative.
    assert f"req={request_id}" in logged
    assert "unhandled exception" in logged
    # The traceback itself has to be there, not just the fact of a failure.
    assert "RuntimeError" in logged
    assert "detonated inside the handler" in logged


def test_configure_logging_is_idempotent(app_with_logging):
    """uvicorn imports the app module more than once; handlers must not stack."""
    _app, _log_path = app_with_logging
    before = len(observability.logger.handlers)

    observability.configure_logging()
    observability.configure_logging()

    assert len(observability.logger.handlers) == before


def test_a_broken_log_directory_does_not_break_the_api(tmp_path, monkeypatch):
    """Logging is support machinery; it must never take the API down with it."""
    logger = observability.logger
    original_handlers = list(logger.handlers)
    for handler in original_handlers:
        logger.removeHandler(handler)

    # A path whose parent is a regular file cannot be created as a directory.
    blocker = tmp_path / "not-a-dir"
    blocker.write_text("", encoding="utf-8")
    monkeypatch.setattr(observability, "LOG_DIR", blocker / "logs")
    monkeypatch.setattr(observability, "LOG_FILE", blocker / "logs" / "backend.log")

    app = FastAPI()

    @app.get("/api/fine")
    async def fine():
        return {"ok": True}

    observability.install(app)

    with TestClient(app) as client:
        assert client.get("/api/fine").status_code == 200

    # It fell back to a stream handler rather than raising at import time.
    assert any(
        isinstance(handler, logging.StreamHandler) for handler in logger.handlers
    )

    for handler in list(logger.handlers):
        logger.removeHandler(handler)
    for handler in original_handlers:
        logger.addHandler(handler)
