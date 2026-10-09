"""Request and error logging.

Before this module the backend had three ``logger`` calls across ~11k lines,
all in ``main.py`` cleanup paths. Nothing recorded which requests arrived, how
long they took, or what happened when one raised. A failure reported from
another device left literally nothing to read.

Two deliberate choices:

* **A rotating file, not stdout.** The backend runs under ``systemd --user``,
  so stdout does land in the journal — but the journal is also where every
  other unit on the box writes, and ``KillMode=process`` means a restart does
  not necessarily rotate anything. A dedicated 5MB x 5 file under ``logs/``
  sits next to the PID and log files ``dolphin-start`` already writes, so
  there is one obvious place to look.

* **Unhandled exceptions are logged and re-raised as a clean 500.** FastAPI's
  default returns a bare "Internal Server Error" with the traceback going
  nowhere. Swallowing the exception here would hide real bugs, so the handler
  records the full traceback with its request id and returns a body carrying
  that same id — the user can quote it and it can be grepped.

Health checks are excluded from the access log on purpose: ``dolphin-status``
and the systemd readiness probes hit ``/health`` continuously, and letting
them in makes the log useless for finding anything else.
"""

from __future__ import annotations

import logging
import logging.handlers
import os
import time
import uuid
from collections.abc import Awaitable, Callable
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

LOG_DIR = Path(
    os.getenv("DOLPHIN_LOG_DIR", Path(__file__).resolve().parents[2] / "logs")
)
LOG_FILE = LOG_DIR / "backend.log"
MAX_BYTES = 5 * 1024 * 1024
BACKUP_COUNT = 5

# Paths that fire on a timer and would otherwise drown out real traffic.
QUIET_PATHS = frozenset({"/health", "/api/dictation/status"})

# Slower than this and the request gets logged at WARNING even if it succeeded.
SLOW_REQUEST_SECONDS = float(os.getenv("DOLPHIN_SLOW_REQUEST_SECONDS", "2.0"))

logger = logging.getLogger("dolphin")


def log_chief_event(event: str, code: str) -> None:
    """Emit a bounded, content-free Chief lifecycle event."""

    allowed_events = {
        "turn_completed",
        "turn_failed",
        "turn_timed_out",
        "turn_cancelled",
    }
    normalized_event = event if event in allowed_events else "turn_failed"
    normalized_code = "".join(
        character
        for character in code[:80]
        if character.isascii() and (character.isalnum() or character == "_")
    ) or "unknown"
    logger.info("chief event=%s code=%s", normalized_event, normalized_code)


def configure_logging() -> None:
    """Attach the rotating file handler exactly once.

    Idempotent because uvicorn's reloader imports the app module more than
    once; attaching per import would multiply every line by the import count.
    """
    if any(
        isinstance(handler, logging.handlers.RotatingFileHandler)
        for handler in logger.handlers
    ):
        return

    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        handler: logging.Handler = logging.handlers.RotatingFileHandler(
            LOG_FILE, maxBytes=MAX_BYTES, backupCount=BACKUP_COUNT, encoding="utf-8"
        )
    except OSError:
        # A read-only or missing log directory must never stop the API from
        # serving. Fall back to stderr, which systemd captures anyway.
        handler = logging.StreamHandler()

    handler.setFormatter(
        logging.Formatter(
            "%(asctime)s %(levelname)-7s %(name)s %(message)s",
            datefmt="%Y-%m-%dT%H:%M:%S",
        )
    )
    logger.addHandler(handler)
    logger.setLevel(os.getenv("DOLPHIN_LOG_LEVEL", "INFO").upper())
    # Let the root logger keep stderr for uvicorn's own lines, but do not
    # double-print ours into it.
    logger.propagate = False


def install(app: FastAPI) -> None:
    """Wire request logging and the unhandled-exception handler onto ``app``."""

    configure_logging()

    @app.middleware("http")
    async def log_requests(
        request: Request, call_next: Callable[[Request], Awaitable]
    ):
        request_id = uuid.uuid4().hex[:12]
        request.state.request_id = request_id
        started = time.perf_counter()

        try:
            response = await call_next(request)
        except Exception:
            elapsed_ms = (time.perf_counter() - started) * 1000
            logger.exception(
                "req=%s %s %s -> unhandled exception after %.1fms",
                request_id,
                request.method,
                request.url.path,
                elapsed_ms,
            )
            return JSONResponse(
                status_code=500,
                content={
                    "detail": "Internal server error.",
                    "request_id": request_id,
                },
            )

        elapsed_ms = (time.perf_counter() - started) * 1000
        response.headers["X-Request-ID"] = request_id

        if request.url.path in QUIET_PATHS and response.status_code < 400:
            return response

        if response.status_code >= 500:
            level = logging.ERROR
        elif response.status_code >= 400 or elapsed_ms >= SLOW_REQUEST_SECONDS * 1000:
            level = logging.WARNING
        else:
            level = logging.INFO

        logger.log(
            level,
            "req=%s %s %s -> %d in %.1fms",
            request_id,
            request.method,
            request.url.path,
            response.status_code,
            elapsed_ms,
        )
        return response
