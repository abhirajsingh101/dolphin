"""Guards for app/migrations.py and for schema drift.

The drift test is the important one. It is the automated version of the manual
check that found two indexes declared in ``models.py`` and absent from the live
database — exactly the divergence the old hand-rolled additive block could not
prevent, and could not even express a fix for.
"""

import asyncio
import hashlib
import json
import sqlite3

import pytest
from sqlalchemy import create_engine, inspect
from alembic.runtime.migration import MigrationContext

from app import migrations
from app.database import Base


PRE_CHIEF_REVISION = "d452673d4a63"
CHIEF_REVISION = "c7c7f07a1b1e"
PROJECT_ORIGIN_REVISION = "9b6f3e8d2a10"
AUTOMATION_REVISION = "c4a8d2f901be"
AUTOMATION_TABLES = {"session_automations", "session_automation_events"}
QUALITY_REVISION = "d9f4a1b782ce"
QUALITY_TABLES = {
    "task_quality_contracts",
    "task_evidence_receipts",
    "task_outcome_lessons",
    "task_quality_events",
}
DIRECTION_REVISION = "e2c8b4195a7d"
PRE_PLANNING_REVISION = "f6b4c8d21e30"
# The last revision that still had Learn/Active automation and learned planning.
PRE_REMOVAL_REVISION = "9324cf29e61e"
HEAD_REVISION = "0e469321b805"
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
    "fleet_triggers",
    "fleet_trigger_items",
    "fleet_lessons",
}
DIRECTION_TABLES = {
    "project_direction_contracts",
    "project_direction_events",
}
PLANNING_TABLES = {"task_proposals", "task_planning_events"}
CHIEF_TABLES = {
    "chief_threads",
    "chief_moment_snapshots",
    "chief_project_snapshots",
    "chief_messages",
    "chief_turn_requests",
    "chief_feedback",
}
# Project registry and proactive signals (7b6ea6689e2a): new, empty, not domain data.
SIGNAL_TABLES = {"project_links", "chat_rooms", "signals", "signal_seen_messages"}
NOTIFICATION_TABLES = {"notifications"}

EXPECTED_CHIEF_COLUMNS = {
    "chief_threads": {
        "id",
        "title",
        "moment_fingerprint",
        "project_fingerprint",
        "created_at",
        "updated_at",
        "version",
    },
    "chief_moment_snapshots": {
        "id",
        "thread_id",
        "fingerprint",
        "schema_version",
        "snapshot_json",
        "snapshot_hash",
        "created_at",
    },
    "chief_project_snapshots": {
        "id",
        "thread_id",
        "fingerprint",
        "schema_version",
        "snapshot_json",
        "snapshot_hash",
        "created_at",
    },
    "chief_messages": {
        "id",
        "thread_id",
        "role",
        "kind",
        "text",
        "payload_json",
        "in_reply_to_message_id",
        "created_at",
    },
    "chief_turn_requests": {
        "id",
        "thread_id",
        "idempotency_key",
        "user_message_id",
        "assistant_message_id",
        "status",
        "attempt_count",
        "response_bytes",
        "error_code",
        "created_at",
        "updated_at",
    },
    "chief_feedback": {
        "id",
        "thread_id",
        "message_id",
        "moment_fingerprint",
        "value",
        "created_at",
        "updated_at",
    },
}

EXPECTED_CHIEF_INDEXES = {
    "chief_threads": {
        "ix_chief_threads_updated_at": (("updated_at",), False),
        "uq_chief_threads_moment_fingerprint": (("moment_fingerprint",), True),
        "uq_chief_threads_project_fingerprint": (("project_fingerprint",), True),
    },
    "chief_moment_snapshots": {
        "uq_chief_moment_snapshots_thread_id": (("thread_id",), True),
        "uq_chief_moment_snapshots_fingerprint": (("fingerprint",), True),
    },
    "chief_project_snapshots": {
        "uq_chief_project_snapshots_thread_id": (("thread_id",), True),
        "uq_chief_project_snapshots_fingerprint": (("fingerprint",), True),
    },
    "chief_messages": {
        "ix_chief_messages_thread_created_at": (
            ("thread_id", "created_at"),
            False,
        ),
        "uq_chief_messages_in_reply_to_message_id": (
            ("in_reply_to_message_id",),
            True,
        ),
    },
    "chief_turn_requests": {
        "uq_chief_turn_requests_thread_id_idempotency_key": (
            ("thread_id", "idempotency_key"),
            True,
        ),
        "ix_chief_turn_requests_thread_status": (("thread_id", "status"), False),
    },
    "chief_feedback": {
        "uq_chief_feedback_message_id": (("message_id",), True),
        "uq_chief_feedback_moment_fingerprint": (("moment_fingerprint",), True),
    },
}

EXPECTED_CHIEF_CHECKS = {
    "chief_threads": {
        "ck_chief_threads_title_length",
        "ck_chief_threads_single_origin",
    },
    "chief_moment_snapshots": {"ck_chief_moment_snapshots_hash_length"},
    "chief_project_snapshots": {"ck_chief_project_snapshots_hash_length"},
    "chief_messages": {
        "ck_chief_messages_role",
        "ck_chief_messages_kind",
        "ck_chief_messages_text_length",
    },
    "chief_turn_requests": {
        "ck_chief_turn_requests_status",
        "ck_chief_turn_requests_idempotency_key_length",
    },
    "chief_feedback": {
        "ck_chief_feedback_target",
        "ck_chief_feedback_value",
    },
}

EXPECTED_CHIEF_FOREIGN_KEYS = {
    "chief_threads": set(),
    "chief_moment_snapshots": {
        (("thread_id",), "chief_threads", ("id",), "CASCADE"),
    },
    "chief_project_snapshots": {
        (("thread_id",), "chief_threads", ("id",), "CASCADE"),
    },
    "chief_messages": {
        (("thread_id",), "chief_threads", ("id",), "CASCADE"),
        (("in_reply_to_message_id",), "chief_messages", ("id",), "CASCADE"),
    },
    "chief_turn_requests": {
        (("thread_id",), "chief_threads", ("id",), "CASCADE"),
        (("user_message_id",), "chief_messages", ("id",), "CASCADE"),
        (("assistant_message_id",), "chief_messages", ("id",), "CASCADE"),
    },
    "chief_feedback": {
        (("thread_id",), "chief_threads", ("id",), "CASCADE"),
        (("message_id",), "chief_messages", ("id",), "CASCADE"),
    },
}


def _fresh_engine(path):
    """A database built the way init_db() builds one: create_all, no version."""
    engine = create_engine(f"sqlite:///{path}", future=True)
    Base.metadata.create_all(engine)
    return engine


def test_baseline_revision_exists():
    """A chain with no base means stamping would silently do nothing."""
    config = migrations._config()
    assert migrations._baseline_revision(config) is not None


def test_models_and_migrations_do_not_drift(tmp_path, monkeypatch):
    """models.py and the migration chain must describe the same schema.

    This is the guard that would have caught the missing serial_queue_id
    indexes. A database built purely by running every migration must be
    indistinguishable from one built by create_all off the models.
    """
    from alembic import command
    from alembic.autogenerate import compare_metadata

    migrated = tmp_path / "migrated.db"
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{migrated}")
    config = migrations._config()
    command.upgrade(config, "head")

    engine = create_engine(f"sqlite:///{migrated}", future=True)
    try:
        with engine.connect() as connection:
            context = MigrationContext.configure(
                connection,
                opts={"compare_type": False},
            )
            diff = compare_metadata(context, Base.metadata)
    finally:
        engine.dispose()

    assert diff == [], f"schema drift between models.py and migrations: {diff}"


def test_interrupted_observed_sequence_backfill_resumes_from_immediate_predecessor(
    tmp_path,
    monkeypatch,
):
    from alembic import command

    path = tmp_path / "interrupted-observed-sequence.db"
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{path}")
    config = migrations._config()
    command.upgrade(config, "b83f9c0a21d7")

    with sqlite3.connect(path) as connection:
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute(
            "INSERT INTO projects "
            "(id, name, emoji, color, path, is_inbox, position, "
            "serial_queue_status, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                "sequence-project",
                "Sequence project",
                "",
                "#246FE0",
                "/tmp/sequence-project",
                0,
                0,
                "idle",
                "2026-09-08T00:00:00",
                "2026-09-08T00:00:00",
            ),
        )
        for proposal_id in ("proposal-a", "proposal-b"):
            connection.execute(
                "INSERT INTO task_proposals "
                "(id, project_id, proposal_key, title, execution_prompt, priority, "
                "desired_outcome, risk_level, acceptance_checks_json, "
                "required_skills_json, rationale, status, revision, "
                "last_source_event_key, context_fingerprint, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    proposal_id,
                    "sequence-project",
                    proposal_id,
                    "Observed sequence",
                    "Verify deterministic observed ordering.",
                    2,
                    "Observed history remains deterministic.",
                    "medium",
                    "[]",
                    "[]",
                    "Migration coverage.",
                    "approved",
                    1,
                    "a" * 64,
                    "b" * 64,
                    "2026-09-08T00:00:00",
                    "2026-09-08T00:00:00",
                ),
            )
        for event_id, proposal_id, created_at, sequence in (
            ("event-a-1", "proposal-a", "2026-09-08T00:00:01", 1),
            ("event-a-2", "proposal-a", "2026-09-08T00:00:02", None),
            ("event-b-1", "proposal-b", "2026-09-08T00:00:01", None),
        ):
            connection.execute(
                "INSERT INTO task_planning_events "
                "(id, project_id, proposal_id, proposal_revision, kind, actor, "
                "source_event_key, snapshot_json, snapshot_hash, "
                "provenance_sequence, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    event_id,
                    "sequence-project",
                    proposal_id,
                    1,
                    "approved",
                    "system:observed-work",
                    "c" * 64,
                    "{}",
                    hashlib.sha256(b"{}").hexdigest(),
                    sequence,
                    created_at,
                ),
            )
        connection.commit()

    command.upgrade(config, PRE_REMOVAL_REVISION)
    with sqlite3.connect(path) as connection:
        rows = connection.execute(
            "SELECT id, provenance_sequence FROM task_planning_events "
            "ORDER BY proposal_id, created_at, id"
        ).fetchall()
        indexes = {
            row[1]: bool(row[2])
            for row in connection.execute("PRAGMA index_list(task_planning_events)")
        }
    assert rows == [("event-a-1", 1), ("event-a-2", 2), ("event-b-1", 1)]
    assert indexes["ix_task_planning_events_proposal_sequence"] is True


def test_observed_sequence_migration_preserves_authoritative_order_across_clock_rollback(
    tmp_path,
    monkeypatch,
):
    from alembic import command

    path = tmp_path / "clock-rollback-observed-sequence.db"
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{path}")
    config = migrations._config()
    command.upgrade(config, "b83f9c0a21d7")
    binding = {
        "automation_id": "clock-automation",
        "origin_generation": 1,
        "tmux_server_id": "server-1",
        "tmux_session_id": "$1",
        "session_name": "clock-session",
        "pane_id": "%1",
        "pane_pid": 42,
        "pane_process_start_ticks": 77,
        "provider": "codex",
        "agent_session_id": "clock-agent",
        "provider_pid": 84,
        "provider_process_start_ticks": 88,
        "source_event_key": "a" * 64,
        "context_fingerprint": "b" * 64,
    }
    payloads = []
    predecessor_id = None
    predecessor_hash = None
    for sequence in (1, 2):
        payload = {
            "schema_version": "dolphin-observed-work-provenance-v1",
            "summary": False,
            "record_type": "observation",
            "result": "matched",
            "task_id": "clock-task",
            "task_scope_sha256": "c" * 64,
            "executor_binding": binding,
            "observation_binding": binding,
            "observation_source_event_key": "a" * 64,
            "predecessor_event_id": predecessor_id,
            "predecessor_sha256": predecessor_hash,
        }
        raw = json.dumps(payload, ensure_ascii=True, separators=(",", ":"), sort_keys=True)
        digest = hashlib.sha256(raw.encode()).hexdigest()
        payloads.append((raw, digest))
        predecessor_id = f"clock-event-{sequence}"
        predecessor_hash = digest
    with sqlite3.connect(path) as connection:
        connection.execute(
            "INSERT INTO projects "
            "(id, name, emoji, color, path, is_inbox, position, serial_queue_status, "
            "created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                "clock-project", "Clock project", "", "#246FE0", "/tmp/clock",
                0, 0, "idle", "2026-09-08T00:00:00", "2026-09-08T00:00:00",
            ),
        )
        connection.execute(
            "INSERT INTO task_proposals "
            "(id, project_id, proposal_key, title, execution_prompt, priority, "
            "desired_outcome, risk_level, acceptance_checks_json, required_skills_json, "
            "rationale, status, revision, last_source_event_key, context_fingerprint, "
            "approved_task_id, decided_by, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                "clock-proposal", "clock-project", "clock-proposal", "Clock work",
                "Preserve sequence authority.", 2, "Sequence remains stable.", "medium",
                "[]", "[]", "Migration coverage.", "approved", 1, "a" * 64,
                "b" * 64, "clock-task", "system:observed-work",
                "2026-09-08T00:00:00", "2026-09-08T00:00:00",
            ),
        )
        for sequence, created_at in (
            (1, "2026-09-08T00:00:02"),
            (2, "2026-09-08T00:00:01"),
        ):
            raw, digest = payloads[sequence - 1]
            connection.execute(
                "INSERT INTO task_planning_events "
                "(id, project_id, proposal_id, proposal_revision, kind, actor, "
                "source_event_key, snapshot_json, snapshot_hash, provenance_sequence, "
                "created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    f"clock-event-{sequence}", "clock-project", "clock-proposal", 1,
                    "approved", "system:observed-work", "a" * 64, raw, digest,
                    sequence, created_at,
                ),
            )
        connection.commit()
    command.upgrade(config, PRE_REMOVAL_REVISION)
    with sqlite3.connect(path) as connection:
        retained = connection.execute(
            "SELECT id, provenance_sequence FROM task_planning_events "
            "ORDER BY provenance_sequence"
        ).fetchall()
        projection = connection.execute(
            "SELECT observed_head_sequence, observed_task_id FROM task_proposals "
            "WHERE id='clock-proposal'"
        ).fetchone()
    assert retained == [("clock-event-1", 1), ("clock-event-2", 2)]
    assert projection == (2, "clock-task")


def test_a_pre_alembic_database_is_stamped_and_upgraded(tmp_path, monkeypatch):
    """The live-database path: tables already exist, no version table."""
    legacy = tmp_path / "legacy.db"
    engine = _fresh_engine(legacy)
    engine.dispose()

    # Simulate the real starting point: created by create_all, so the declared
    # indexes are present. Drop one to prove the upgrade actually restores it.
    raw = sqlite3.connect(legacy)
    raw.execute("DROP INDEX IF EXISTS ix_projects_serial_queue_id")
    raw.commit()
    raw.close()

    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{legacy}")

    landed = migrations.upgrade()
    assert landed is not None

    check = create_engine(f"sqlite:///{legacy}", future=True)
    try:
        indexes = {
            index["name"] for index in inspect(check).get_indexes("projects")
        }
    finally:
        check.dispose()
    assert "ix_projects_serial_queue_id" in indexes


def test_upgrade_is_idempotent(tmp_path, monkeypatch):
    """Every backend restart runs this; the second run must be a no-op."""
    path = tmp_path / "repeat.db"
    _fresh_engine(path).dispose()
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{path}")

    first = migrations.upgrade()
    second = migrations.upgrade()
    assert first == second


def test_upgrade_preserves_existing_rows(tmp_path, monkeypatch):
    """A migration that loses data is worse than no migration."""
    path = tmp_path / "withdata.db"
    engine = _fresh_engine(path)
    with engine.begin() as connection:
        from sqlalchemy import text

        connection.execute(
            text(
                "INSERT INTO projects (id, name, emoji, color, path, is_inbox,"
                " position, created_at, updated_at) VALUES"
                " ('p1', 'Keep Me', '🐬', '#246FE0', '/tmp/p1', 0, 0,"
                " '2026-01-01', '2026-01-01')"
            )
        )
    engine.dispose()

    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{path}")
    migrations.upgrade()

    check = sqlite3.connect(path)
    try:
        names = [row[0] for row in check.execute("SELECT name FROM projects")]
        assert check.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    finally:
        check.close()
    assert names == ["Keep Me"]


def test_sync_url_strips_the_async_driver(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "sqlite+aiosqlite:///./x.db")
    assert migrations.sync_url() == "sqlite:///./x.db"


def test_running_migrations_does_not_disable_request_logging(tmp_path, monkeypatch):
    """Alembic must not switch observability off on its way past.

    alembic/env.py calls logging.config.fileConfig, whose `disable_existing_loggers`
    defaults to True — which disables every logger not named in alembic.ini,
    including "dolphin". Since migrations run in-process at startup, the default
    silently killed all request and error logging in production. This failed
    only in the full suite, never in isolation, which is exactly why it needs a
    named guard rather than relying on ordering luck.
    """
    from app import observability

    log_file = tmp_path / "backend.log"
    monkeypatch.setattr(observability, "LOG_DIR", tmp_path)
    monkeypatch.setattr(observability, "LOG_FILE", log_file)

    logger = observability.logger
    original = list(logger.handlers)
    for handler in original:
        logger.removeHandler(handler)
    observability.configure_logging()

    try:
        path = tmp_path / "logging.db"
        _fresh_engine(path).dispose()
        monkeypatch.setenv("DATABASE_URL", f"sqlite:///{path}")
        migrations.upgrade()

        assert logger.disabled is False
        logger.info("still alive after migrations")
        for handler in logger.handlers:
            handler.flush()
        assert "still alive after migrations" in log_file.read_text(encoding="utf-8")
    finally:
        for handler in list(logger.handlers):
            handler.close()
            logger.removeHandler(handler)
        for handler in original:
            logger.addHandler(handler)


def _schema_digest(path):
    """Stable schema-only digest used to prove a second upgrade is a no-op."""

    connection = sqlite3.connect(path)
    try:
        rows = connection.execute(
            "SELECT type, name, tbl_name, sql FROM sqlite_master "
            "WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
        ).fetchall()
    finally:
        connection.close()
    payload = json.dumps(rows, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _domain_rows(path):
    """Exact pre/post domain snapshot; Chief tables are deliberately excluded."""

    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    try:
        tables = [
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master "
                "WHERE type='table' AND name NOT LIKE 'sqlite_%' "
                "AND name != 'alembic_version' ORDER BY name"
            )
            if row[0]
            not in (
                CHIEF_TABLES
                | {"dolphin_tool_runs"}
                | AUTOMATION_TABLES
                | QUALITY_TABLES
                | DIRECTION_TABLES
                | PLANNING_TABLES
                | FLEET_TABLES
                | SIGNAL_TABLES
                | NOTIFICATION_TABLES
            )
        ]
        snapshot = {}
        for table in tables:
            rows = [
                dict(row)
                for row in connection.execute(
                    f'SELECT * FROM "{table.replace(chr(34), chr(34) * 2)}"'
                )
            ]
            if table == "tasks":
                for row in rows:
                    row.pop("origin", None)
                    row.pop("execution_prompt", None)
                    row.pop("source_proposal_id", None)
            snapshot[table] = rows
        return snapshot
    finally:
        connection.close()


def _upgrade_from_pre_chief(path, monkeypatch):
    """Build the real legacy predecessor, seed data, then upgrade to head."""

    from alembic import command

    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{path}")
    config = migrations._config()
    command.upgrade(config, PRE_CHIEF_REVISION)

    connection = sqlite3.connect(path)
    try:
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute(
            "INSERT INTO projects "
            "(id, name, emoji, color, path, is_inbox, position, "
            " serial_queue_status, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                "chief-migration-project",
                "Preserve project",
                "",
                "#246FE0",
                "/tmp/chief-migration-project",
                0,
                0,
                "idle",
                "2026-08-11T09:30:00",
                "2026-08-11T09:30:00",
            ),
        )
        connection.execute(
            "INSERT INTO tasks "
            "(id, project_id, title, description, priority, is_done, position, "
            " created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                "chief-migration-task",
                "chief-migration-project",
                "Preserve task",
                "",
                4,
                0,
                0,
                "2026-08-11T09:30:00",
                "2026-08-11T09:30:00",
            ),
        )
        connection.execute(
            "INSERT INTO runs "
            "(id, task_id, project_id, session_name, agent, workspace_path, "
            " state, dispatched_at, turn_count, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                "chief-migration-run",
                "chief-migration-task",
                "chief-migration-project",
                "chief-migration-session",
                "codex",
                "/tmp/chief-migration-project",
                "dispatched",
                "2026-08-11T09:30:00",
                0,
                "2026-08-11T09:30:00",
                "2026-08-11T09:30:00",
            ),
        )
        connection.commit()
    finally:
        connection.close()

    before = _domain_rows(path)
    command.upgrade(config, "head")
    return config, before


def _reflected_foreign_keys(inspector, table):
    return {
        (
            tuple(item["constrained_columns"]),
            item["referred_table"],
            tuple(item["referred_columns"]),
            str(item.get("options", {}).get("ondelete", "")).upper(),
        )
        for item in inspector.get_foreign_keys(table)
    }


def _reflected_indexes(inspector, table):
    return {
        item["name"]: (
            tuple(item["column_names"]),
            bool(item["unique"]),
        )
        for item in inspector.get_indexes(table)
    }


def test_chief_models_declare_exact_operational_table_inventory():
    assert CHIEF_TABLES <= set(Base.metadata.tables)
    assert not {
        foreign_key.column.table.name
        for table_name in CHIEF_TABLES
        for column in Base.metadata.tables[table_name].columns
        for foreign_key in column.foreign_keys
        if foreign_key.column.table.name not in CHIEF_TABLES
    }

    for table_name, expected_columns in EXPECTED_CHIEF_COLUMNS.items():
        # SQLAlchemy ColumnCollection iteration yields Column objects, while
        # this contract intentionally compares the exact column-name set.
        assert set(Base.metadata.tables[table_name].columns.keys()) == expected_columns


def test_chief_migration_upgrade_has_exact_columns_indexes_checks_and_cascades(
    tmp_path,
    monkeypatch,
):
    path = tmp_path / "chief-schema.db"
    _config, before = _upgrade_from_pre_chief(path, monkeypatch)
    engine = create_engine(f"sqlite:///{path}", future=True)
    try:
        schema = inspect(engine)
        assert CHIEF_TABLES <= set(schema.get_table_names())
        for table_name in sorted(CHIEF_TABLES):
            assert {item["name"] for item in schema.get_columns(table_name)} == (
                EXPECTED_CHIEF_COLUMNS[table_name]
            )
            assert _reflected_indexes(schema, table_name) == (
                EXPECTED_CHIEF_INDEXES[table_name]
            )
            assert {
                item["name"] for item in schema.get_check_constraints(table_name)
            } == EXPECTED_CHIEF_CHECKS[table_name]
            assert _reflected_foreign_keys(schema, table_name) == (
                EXPECTED_CHIEF_FOREIGN_KEYS[table_name]
            )
    finally:
        engine.dispose()

    assert _domain_rows(path) == before
    connection = sqlite3.connect(path)
    try:
        connection.execute("PRAGMA foreign_keys=ON")
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
    finally:
        connection.close()


def test_chief_upgrade_is_schema_idempotent_and_lands_on_exact_revision(
    tmp_path,
    monkeypatch,
):
    from alembic import command

    path = tmp_path / "chief-repeat.db"
    config, before = _upgrade_from_pre_chief(path, monkeypatch)
    first_digest = _schema_digest(path)
    first_rows = _domain_rows(path)

    command.upgrade(config, "head")

    assert _schema_digest(path) == first_digest
    assert _domain_rows(path) == first_rows == before
    engine = create_engine(f"sqlite:///{path}", future=True)
    try:
        with engine.connect() as connection:
            assert MigrationContext.configure(connection).get_current_revision() == (
                HEAD_REVISION
            )
    finally:
        engine.dispose()


def test_learned_todo_migration_backfills_exact_prompts_and_round_trips(
    tmp_path,
    monkeypatch,
):
    from alembic import command

    path = tmp_path / "learned-todo-round-trip.db"
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{path}")
    config = migrations._config()
    command.upgrade(config, PRE_PLANNING_REVISION)
    connection = sqlite3.connect(path)
    try:
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute(
            "INSERT INTO projects "
            "(id, name, emoji, color, path, is_inbox, position, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                "planning-project",
                "Dolphin Tasks",
                "",
                "#246FE0",
                "/tmp/dolphin-tasks",
                0,
                0,
                "2026-09-06T20:00:00",
                "2026-09-06T20:00:00",
            ),
        )
        connection.executemany(
            "INSERT INTO tasks "
            "(id, project_id, title, description, priority, is_done, position, "
            "created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [
                (
                    "task-description",
                    "planning-project",
                    "Description wins",
                    "Use this existing detailed instruction.",
                    4,
                    0,
                    0,
                    "2026-09-06T20:00:00",
                    "2026-09-06T20:00:00",
                ),
                (
                    "task-title",
                    "planning-project",
                    "Fall back to this title",
                    "",
                    4,
                    0,
                    1,
                    "2026-09-06T20:00:00",
                    "2026-09-06T20:00:00",
                ),
            ],
        )
        connection.commit()
    finally:
        connection.close()

    command.upgrade(config, PRE_REMOVAL_REVISION)
    engine = create_engine(f"sqlite:///{path}", future=True)
    try:
        schema = inspect(engine)
        assert PLANNING_TABLES <= set(schema.get_table_names())
        assert {"origin", "execution_prompt", "source_proposal_id"} <= {
            item["name"] for item in schema.get_columns("tasks")
        }
        assert {"context_fingerprint", "approved_task_id"} <= {
            item["name"] for item in schema.get_columns("task_proposals")
        }
        assert _reflected_indexes(schema, "tasks")["ix_tasks_source_proposal_id"] == (
            ("source_proposal_id",),
            True,
        )
        assert _reflected_indexes(schema, "task_planning_events")[
            "ix_task_planning_events_proposal_actor_created"
        ] == (("proposal_id", "actor", "created_at", "id"), False)
        with engine.connect() as connection:
            rows = connection.exec_driver_sql(
                "SELECT id, origin, execution_prompt FROM tasks ORDER BY id"
            ).all()
            assert rows == [
                (
                    "task-description",
                    "human",
                    "Use this existing detailed instruction.",
                ),
                ("task-title", "human", "Fall back to this title"),
            ]
    finally:
        engine.dispose()

    command.downgrade(config, PRE_PLANNING_REVISION)
    engine = create_engine(f"sqlite:///{path}", future=True)
    try:
        schema = inspect(engine)
        assert PLANNING_TABLES.isdisjoint(schema.get_table_names())
        assert {"origin", "execution_prompt", "source_proposal_id"}.isdisjoint(
            item["name"] for item in schema.get_columns("tasks")
        )
        with engine.connect() as connection:
            assert connection.exec_driver_sql("SELECT count(*) FROM tasks").scalar_one() == 2
            assert MigrationContext.configure(connection).get_current_revision() == (
                PRE_PLANNING_REVISION
            )
    finally:
        engine.dispose()


def test_chief_downgrade_removes_only_new_revision_and_preserves_domain_rows(
    tmp_path,
    monkeypatch,
):
    from alembic import command

    path = tmp_path / "chief-downgrade.db"
    config, before = _upgrade_from_pre_chief(path, monkeypatch)
    connection = sqlite3.connect(path)
    try:
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute(
            "INSERT INTO chief_threads "
            "(id, title, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?)",
            (
                "chief-thread-downgrade",
                "Disposable conversation",
                "2026-08-11T09:30:00",
                "2026-08-11T09:30:00",
                1,
            ),
        )
        connection.execute(
            "INSERT INTO chief_messages "
            "(id, thread_id, role, kind, text, payload_json, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                "chief-message-downgrade",
                "chief-thread-downgrade",
                "user",
                "text",
                "Synthetic message",
                "{}",
                "2026-08-11T09:30:00",
            ),
        )
        connection.commit()
    finally:
        connection.close()

    command.downgrade(config, PRE_CHIEF_REVISION)

    engine = create_engine(f"sqlite:///{path}", future=True)
    try:
        schema = inspect(engine)
        assert not CHIEF_TABLES & set(schema.get_table_names())
        assert {"projects", "tasks", "runs"} <= set(schema.get_table_names())
        with engine.connect() as connection:
            assert MigrationContext.configure(connection).get_current_revision() == (
                PRE_CHIEF_REVISION
            )
    finally:
        engine.dispose()
    assert _domain_rows(path) == before


def test_chief_downgrade_then_reupgrade_recovers_schema_without_domain_drift(
    tmp_path,
    monkeypatch,
):
    from alembic import command

    path = tmp_path / "chief-round-trip.db"
    config, before = _upgrade_from_pre_chief(path, monkeypatch)
    command.downgrade(config, PRE_CHIEF_REVISION)
    command.upgrade(config, "head")

    engine = create_engine(f"sqlite:///{path}", future=True)
    try:
        schema = inspect(engine)
        assert CHIEF_TABLES <= set(schema.get_table_names())
        for table_name in CHIEF_TABLES:
            assert set(EXPECTED_CHIEF_INDEXES[table_name]) == set(
                _reflected_indexes(schema, table_name)
            )
    finally:
        engine.dispose()
    assert _domain_rows(path) == before

    connection = sqlite3.connect(path)
    try:
        connection.execute("PRAGMA foreign_keys=ON")
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
        assert connection.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    finally:
        connection.close()


def test_project_origin_one_revision_round_trip_preserves_existing_chief_and_domain_rows(
    tmp_path,
    monkeypatch,
):
    from alembic import command

    path = tmp_path / "project-origin-round-trip.db"
    config, domain_before = _upgrade_from_pre_chief(path, monkeypatch)
    connection = sqlite3.connect(path)
    try:
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute(
            "INSERT INTO chief_threads "
            "(id, title, project_fingerprint, created_at, updated_at, version) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (
                "project-origin-thread",
                "Synthetic project origin",
                "b" * 64,
                "2030-01-02T03:04:05",
                "2030-01-02T03:04:05",
                1,
            ),
        )
        connection.execute(
            "INSERT INTO chief_project_snapshots "
            "(id, thread_id, fingerprint, schema_version, snapshot_json, "
            "snapshot_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                "project-origin-snapshot",
                "project-origin-thread",
                "b" * 64,
                "chief-project-snapshot-v1",
                '{"schema_version":"chief-project-snapshot-v1"}',
                "c" * 64,
                "2030-01-02T03:04:05",
            ),
        )
        connection.execute(
            "INSERT INTO chief_messages "
            "(id, thread_id, role, kind, text, payload_json, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                "project-origin-message",
                "project-origin-thread",
                "user",
                "text",
                "Synthetic message survives one-revision downgrade",
                "{}",
                "2030-01-02T03:04:05",
            ),
        )
        connection.commit()
    finally:
        connection.close()

    command.downgrade(config, CHIEF_REVISION)
    engine = create_engine(f"sqlite:///{path}", future=True)
    try:
        schema = inspect(engine)
        assert "chief_project_snapshots" not in schema.get_table_names()
        assert "project_fingerprint" not in {
            item["name"] for item in schema.get_columns("chief_threads")
        }
        with engine.connect() as connection:
            assert MigrationContext.configure(connection).get_current_revision() == (
                CHIEF_REVISION
            )
            assert connection.exec_driver_sql(
                "SELECT title FROM chief_threads WHERE id='project-origin-thread'"
            ).scalar_one() == "Synthetic project origin"
            assert connection.exec_driver_sql(
                "SELECT text FROM chief_messages WHERE id='project-origin-message'"
            ).scalar_one() == "Synthetic message survives one-revision downgrade"
    finally:
        engine.dispose()
    assert _domain_rows(path) == domain_before

    command.upgrade(config, "head")
    engine = create_engine(f"sqlite:///{path}", future=True)
    try:
        schema = inspect(engine)
        assert "chief_project_snapshots" in schema.get_table_names()
        assert "project_fingerprint" in {
            item["name"] for item in schema.get_columns("chief_threads")
        }
        with engine.connect() as connection:
            assert MigrationContext.configure(connection).get_current_revision() == (
                HEAD_REVISION
            )
            assert connection.exec_driver_sql(
                "SELECT count(*) FROM chief_project_snapshots"
            ).scalar_one() == 0
            assert connection.exec_driver_sql(
                "SELECT count(*) FROM chief_messages "
                "WHERE id='project-origin-message'"
            ).scalar_one() == 1
    finally:
        engine.dispose()
    assert _domain_rows(path) == domain_before


def test_alembic_inventory_excludes_disposable_activity_cache_tables(tmp_path, monkeypatch):
    path = tmp_path / "no-activity-cache.db"
    _config, _before = _upgrade_from_pre_chief(path, monkeypatch)
    with sqlite3.connect(path) as connection:
        tables = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            )
        }
    assert not {
        "source_files",
        "session_bindings",
        "activity_events",
        "project_digests",
        "project_coverage",
        "scan_runs",
        "activity_fts",
    } & tables


def test_active_automation_rows_survive_quality_direction_and_owner_migrations(
    tmp_path,
    monkeypatch,
):
    from alembic import command

    path = tmp_path / "active-preservation.db"
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{path}")
    config = migrations._config()
    command.upgrade(config, AUTOMATION_REVISION)

    with sqlite3.connect(path) as connection:
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute(
            "INSERT INTO projects "
            "(id, name, emoji, color, path, is_inbox, position, "
            "serial_queue_status, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                "active-project",
                "Active project",
                "",
                "#246FE0",
                "/tmp/active-project",
                0,
                0,
                "idle",
                "2026-09-01T00:00:00",
                "2026-09-01T00:00:00",
            ),
        )
        connection.execute(
            "INSERT INTO tasks "
            "(id, project_id, title, description, priority, is_done, position, "
            "created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                "active-task",
                "active-project",
                "Preserve active task",
                "Bound work",
                1,
                0,
                0,
                "2026-09-01T00:00:00",
                "2026-09-01T00:00:00",
            ),
        )
        connection.execute(
            "INSERT INTO task_workflows "
            "(task_id, state, research_status, research_brief, cleanup_status, "
            "serial_queue_status, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                "active-task",
                "in_progress",
                "idle",
                "",
                "not_applicable",
                "not_queued",
                "2026-09-01T00:00:00",
                "2026-09-01T00:00:00",
            ),
        )
        connection.execute(
            "INSERT INTO session_automations "
            "(id, project_id, session_name, tmux_server_id, tmux_session_id, "
            "pane_id, pane_pid, pane_process_start_ticks, provider, mode, state, "
            "generation, goal, work_scope, initial_goal_completed, active_task_id, "
            "active_task_title, active_task_source, active_task_fingerprint, "
            "created_at, updated_at) VALUES "
            "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                "active-automation",
                "active-project",
                "active-session",
                "server-1",
                "$1",
                "%1",
                42,
                77,
                "codex",
                "active",
                "waiting",
                7,
                "Preserve the exact goal",
                "project_queue",
                1,
                "active-task",
                "Preserve active task",
                "in_progress_task",
                "f" * 64,
                "2026-09-01T00:00:00",
                "2026-09-01T00:00:00",
            ),
        )
        connection.execute(
            "INSERT INTO session_automation_events "
            "(id, automation_id, event_key, kind, provider, status, generation, "
            "created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                "active-event",
                "active-automation",
                "e" * 64,
                "turn_stop",
                "codex",
                "processed",
                7,
                "2026-09-01T00:00:00",
            ),
        )
        connection.commit()

    command.upgrade(config, PRE_REMOVAL_REVISION)
    with sqlite3.connect(path) as connection:
        row = connection.execute(
            "SELECT mode, state, generation, goal, work_scope, active_task_id, "
            "active_task_fingerprint, active_direction_revision "
            "FROM session_automations WHERE id='active-automation'"
        ).fetchone()
        assert row == (
            "active",
            "waiting",
            7,
            "Preserve the exact goal",
            "project_queue",
            "active-task",
            "f" * 64,
            None,
        )
        workflow = connection.execute(
            "SELECT state, automation_owner_id FROM task_workflows "
            "WHERE task_id='active-task'"
        ).fetchone()
        assert workflow == ("in_progress", None)
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []


def test_direction_downgrade_converts_live_scope_before_restoring_old_check(
    tmp_path,
    monkeypatch,
):
    from alembic import command

    path = tmp_path / "direction-downgrade.db"
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{path}")
    config = migrations._config()
    command.upgrade(config, AUTOMATION_REVISION)
    with sqlite3.connect(path) as connection:
        connection.execute(
            "INSERT INTO projects "
            "(id, name, emoji, color, path, is_inbox, position, "
            "serial_queue_status, created_at, updated_at) "
            "VALUES ('p', 'Project', '', '#246FE0', '/tmp/p', 0, 0, 'idle', "
            "'2026-09-01', '2026-09-01')"
        )
        connection.execute(
            "INSERT INTO session_automations "
            "(id, project_id, session_name, tmux_server_id, tmux_session_id, "
            "pane_id, pane_pid, pane_process_start_ticks, provider, mode, state, "
            "generation, goal, work_scope, initial_goal_completed, created_at, updated_at) "
            "VALUES ('a', 'p', 's', 'server', '$1', '%1', 42, 77, 'codex', "
            "'active', 'waiting', 3, 'Goal', 'project_queue', 1, "
            "'2026-09-01', '2026-09-01')"
        )
        connection.commit()
    command.upgrade(config, PRE_REMOVAL_REVISION)
    with sqlite3.connect(path) as connection:
        connection.execute(
            "UPDATE session_automations SET work_scope='direction_queue', "
            "active_direction_revision=2, active_direction_fingerprint=? "
            "WHERE id='a'",
            ("d" * 64,),
        )
        connection.commit()

    command.downgrade(config, QUALITY_REVISION)
    with sqlite3.connect(path) as connection:
        columns = {
            row[1]
            for row in connection.execute("PRAGMA table_info(session_automations)")
        }
        row = connection.execute(
            "SELECT work_scope, generation, goal FROM session_automations WHERE id='a'"
        ).fetchone()
        assert row == ("project_queue", 3, "Goal")
        assert "active_direction_revision" not in columns
        assert "active_direction_fingerprint" not in columns


def test_automation_removal_drops_its_tables_and_keeps_every_task(tmp_path, monkeypatch):
    from alembic import command

    path = tmp_path / "automation-removal.db"
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{path}")
    config = migrations._config()
    command.upgrade(config, PRE_REMOVAL_REVISION)
    with sqlite3.connect(path) as connection:
        connection.execute(
            "INSERT INTO projects (id, name, emoji, color, path, is_inbox, position, "
            "serial_queue_status, created_at, updated_at) VALUES "
            "('p', 'Project', '', '#246FE0', '/tmp/p', 0, 0, 'idle', '2026-09-01', '2026-09-01')"
        )
        connection.execute(
            "INSERT INTO task_proposals (id, project_id, proposal_key, title, execution_prompt, "
            "priority, desired_outcome, risk_level, acceptance_checks_json, required_skills_json, "
            "rationale, status, revision, last_source_event_key, context_fingerprint, "
            "created_at, updated_at) VALUES ('proposal', 'p', 'key', 'Learned', 'Do it', 4, "
            "'Done', 'low', '[]', '[]', 'Why', 'approved', 1, 'event', 'f', "
            "'2026-09-01', '2026-09-01')"
        )
        connection.execute(
            "INSERT INTO task_planning_events (id, project_id, proposal_id, proposal_revision, "
            "kind, actor, source_event_key, snapshot_json, snapshot_hash, created_at) VALUES "
            "('event', 'p', 'proposal', 1, 'approved', 'system:learn', 'event', '{}', 'h', "
            "'2026-09-01')"
        )
        for task_id, origin, proposal in (("learned", "dolphin", "proposal"), ("typed", "human", None)):
            connection.execute(
                "INSERT INTO tasks (id, project_id, title, description, priority, is_done, "
                "position, origin, execution_prompt, source_proposal_id, created_at, updated_at) "
                "VALUES (?, 'p', ?, '', 4, 0, 0, ?, 'Run it', ?, '2026-09-01', '2026-09-01')",
                (task_id, task_id.title(), origin, proposal),
            )
        connection.execute(
            "INSERT INTO session_automations (id, project_id, session_name, tmux_server_id, "
            "tmux_session_id, pane_id, pane_pid, pane_process_start_ticks, provider, mode, state, "
            "generation, goal, created_at, updated_at) VALUES ('a', 'p', 's', 'server', '$1', "
            "'%1', 42, 77, 'codex', 'learn', 'observing', 1, '', '2026-09-01', '2026-09-01')"
        )
        connection.commit()

    command.upgrade(config, "head")
    removed = AUTOMATION_TABLES | PLANNING_TABLES | DIRECTION_TABLES
    with sqlite3.connect(path) as connection:
        tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        assert removed.isdisjoint(tables)
        assert connection.execute(
            "SELECT id, origin, execution_prompt FROM tasks ORDER BY id"
        ).fetchall() == [("learned", "dolphin", "Run it"), ("typed", "human", "Run it")]
        task_columns = {row[1] for row in connection.execute("PRAGMA table_info(tasks)")}
        workflow_columns = {row[1] for row in connection.execute("PRAGMA table_info(task_workflows)")}
        assert "source_proposal_id" not in task_columns
        assert "automation_owner_id" not in workflow_columns
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []

    command.downgrade(config, PRE_REMOVAL_REVISION)
    with sqlite3.connect(path) as connection:
        tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        assert removed <= tables
        assert connection.execute("SELECT count(*) FROM tasks").fetchone() == (2,)
