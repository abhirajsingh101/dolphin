"""Dolphin chat thread storage and its CRUD routes.

The tables keep their historical ``chief_*`` names; the Chief turn service,
moments and activity context that once shared them are gone. The Dolphin agent
writes turns through the same repository (``begin_turn`` / ``complete_turn``).
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import event, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app import main
from app.chief_conversation_repository import ChiefConversationRepository
from app.database import Base, get_db
from app.models import ChiefMessage, Project, Run, Task, generate_id


AT = datetime(2026, 8, 11, 9, 30, tzinfo=timezone.utc)
THREAD_PATH = "/api/chief/threads"
CHIEF_TABLES = {
    "chief_threads",
    "chief_moment_snapshots",
    "chief_project_snapshots",
    "chief_messages",
    "chief_turn_requests",
    "chief_feedback",
}


@pytest_asyncio.fixture
async def temporary_database(tmp_path):
    """A private SQLite database with FK enforcement and seeded domain rows."""

    path = tmp_path / "chat-threads.db"
    engine = create_async_engine(f"sqlite+aiosqlite:///{path}")

    @event.listens_for(engine.sync_engine, "connect")
    def _foreign_keys_on(dbapi_connection, _connection_record):
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    session_factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with session_factory() as session:
        project = Project(id="domain-project", name="Domain sentinel", path="/tmp/domain-sentinel")
        task = Task(id="domain-task", project_id=project.id, title="Must remain byte-identical")
        run = Run(
            id="domain-run",
            task_id=task.id,
            project_id=project.id,
            session_name="domain-session",
            agent="codex",
            workspace_path="/tmp/domain-sentinel",
        )
        session.add(project)
        await session.flush()
        session.add(task)
        await session.flush()
        session.add(run)
        await session.commit()

    try:
        yield path, engine, session_factory
    finally:
        await engine.dispose()


@pytest_asyncio.fixture
async def http_client(temporary_database):
    _path, _engine, session_factory = temporary_database

    async def override_get_db():
        async with session_factory() as session:
            yield session

    main.app.dependency_overrides[get_db] = override_get_db
    try:
        async with AsyncClient(transport=ASGITransport(app=main.app), base_url="http://test") as client:
            yield client
    finally:
        main.app.dependency_overrides.pop(get_db, None)


def _fingerprints(path: Path, *, exclude: set[str]) -> dict[str, str]:
    result: dict[str, str] = {}
    with sqlite3.connect(path) as connection:
        connection.row_factory = sqlite3.Row
        tables = [
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
            )
        ]
        for table in sorted(tables):
            if table in exclude:
                continue
            rows = sorted(repr(sorted(dict(row).items())) for row in connection.execute(f'SELECT * FROM "{table}"'))
            result[table] = hashlib.sha256(json.dumps(rows).encode()).hexdigest()
    return result


@pytest.mark.asyncio
async def test_repository_crud_bounds_order_and_sanitized_not_found(temporary_database):
    _path, _engine, session_factory = temporary_database
    async with session_factory() as session:
        repository = ChiefConversationRepository(session)
        first = await repository.create_thread(title="First", now=AT)
        second = await repository.create_thread(title="Second", now=AT.replace(minute=31))
        renamed = await repository.rename_thread(first.id, "Renamed thread", now=AT.replace(minute=32))

        assert renamed.title == "Renamed thread"
        assert first.moment_fingerprint is None and first.project_snapshot is None
        assert [thread.id for thread in await repository.list_threads(limit=100)] == [first.id, second.id]
        for invalid in ("", " ", "x" * 81):
            with pytest.raises(ValueError, match="title"):
                await repository.create_thread(title=invalid)
            with pytest.raises(ValueError, match="title"):
                await repository.rename_thread(first.id, invalid)
        for invalid_limit in (0, 101):
            with pytest.raises(ValueError, match="limit"):
                await repository.list_threads(limit=invalid_limit)

        opaque = uuid.uuid4().hex
        with pytest.raises(Exception) as caught:
            await repository.get_thread(opaque)
        assert opaque not in str(caught.value)


@pytest.mark.asyncio
async def test_thread_detail_window_returns_the_newest_100_messages_in_display_order(temporary_database):
    _path, _engine, session_factory = temporary_database
    async with session_factory() as session:
        repository = ChiefConversationRepository(session)
        thread = await repository.create_thread(title="Long thread", now=AT)
        for index in range(102):
            session.add(
                ChiefMessage(
                    id=generate_id(),
                    thread_id=thread.id,
                    role="user" if index % 2 == 0 else "assistant",
                    kind="text" if index % 2 == 0 else "response",
                    text=f"message-{index:03d}",
                    payload_json="{}",
                    in_reply_to_message_id=None,
                    created_at=AT + timedelta(seconds=index),
                )
            )
        await session.commit()

        messages = await repository.list_messages(thread.id)

        assert len(messages) == 100
        assert [message.text for message in messages[:2]] == ["message-002", "message-003"]
        assert [message.text for message in messages[-2:]] == ["message-100", "message-101"]


@pytest.mark.asyncio
async def test_turn_idempotency_pending_and_completed_replay_are_durable(temporary_database):
    _path, _engine, session_factory = temporary_database
    async with session_factory() as first_session, session_factory() as second_session:
        first = ChiefConversationRepository(first_session)
        second = ChiefConversationRepository(second_session)
        thread = await first.create_thread(title="Turns", now=AT)
        key = str(uuid.uuid4())

        accepted = await first.begin_turn(thread.id, idempotency_key=key, user_text="What now?", now=AT)
        duplicate = await second.begin_turn(thread.id, idempotency_key=key, user_text="What now?", now=AT)

        assert accepted.status == "pending" and accepted.should_generate
        assert duplicate.status == "in_progress" and not duplicate.should_generate
        assert duplicate.turn_request_id == accepted.turn_request_id
        assert await first.list_pending_idempotency_keys(thread.id) == [key]

        payload = {"display_text": "Inspect the dependency.", "assistant_message_id": "assistant-one"}
        response_bytes = json.dumps(payload).encode()
        completed = await first.complete_turn(
            thread.id, accepted.turn_request_id, assistant_payload=payload, response_bytes=response_bytes
        )
        replay = await second.begin_turn(thread.id, idempotency_key=key, user_text="What now?")

        assert completed.status == "completed" and replay.status == "completed"
        assert replay.response_bytes == response_bytes
        assert await first.list_pending_idempotency_keys(thread.id) == []
        counts = await first_session.execute(
            text(
                "SELECT (SELECT count(*) FROM chief_messages WHERE thread_id=:t AND role='user'),"
                " (SELECT count(*) FROM chief_messages WHERE thread_id=:t AND role='assistant'),"
                " (SELECT count(*) FROM chief_turn_requests WHERE thread_id=:t)"
            ),
            {"t": thread.id},
        )
        assert tuple(counts.one()) == (1, 1, 1)


@pytest.mark.asyncio
async def test_failed_turn_is_terminal_and_never_completed(temporary_database):
    _path, _engine, session_factory = temporary_database
    async with session_factory() as session:
        repository = ChiefConversationRepository(session)
        thread = await repository.create_thread(title="Failure", now=AT)
        turn = await repository.begin_turn(thread.id, idempotency_key=str(uuid.uuid4()), user_text="Go")

        failed = await repository.mark_turn_failed(
            thread.id, turn.turn_request_id, status="timed_out", error_code="agent_timeout"
        )

        assert failed.status == "timed_out"
        assert await repository.list_pending_idempotency_keys(thread.id) == []
        with pytest.raises(Exception, match="no longer pending"):
            await repository.complete_turn(
                thread.id,
                turn.turn_request_id,
                assistant_payload={"display_text": "late"},
                response_bytes=b"late",
            )


@pytest.mark.asyncio
async def test_delete_cascades_exact_selected_thread_and_preserves_every_domain_table(temporary_database):
    path, _engine, session_factory = temporary_database
    async with session_factory() as session:
        repository = ChiefConversationRepository(session)
        selected = await repository.create_thread(title="Delete me")
        retained = await repository.create_thread(title="Keep me")
        await repository.begin_turn(selected.id, idempotency_key=str(uuid.uuid4()), user_text="Only this one")
        before_domain = _fingerprints(path, exclude=CHIEF_TABLES)

        assert await repository.delete_thread(selected.id) is True
        assert _fingerprints(path, exclude=CHIEF_TABLES) == before_domain
        assert (await repository.get_thread(retained.id)).id == retained.id

    with sqlite3.connect(path) as connection:
        for table in ("chief_messages", "chief_turn_requests"):
            count = connection.execute(f"SELECT count(*) FROM {table} WHERE thread_id=?", (selected.id,)).fetchone()[0]
            assert count == 0, table
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []


@pytest.mark.asyncio
async def test_thread_routes_round_trip(http_client):
    assert (await http_client.get(THREAD_PATH)).json() == []

    created = await http_client.post(THREAD_PATH, json={"title": "Plan the week"})
    assert created.status_code == 201
    thread = created.json()
    assert thread["title"] == "Plan the week"
    assert thread["moment_fingerprint"] is None and thread["project_snapshot_key"] is None

    detail = await http_client.get(f"{THREAD_PATH}/{thread['id']}")
    assert detail.status_code == 200
    assert detail.json()["messages"] == [] and detail.json()["pending_idempotency_keys"] == []

    renamed = await http_client.patch(f"{THREAD_PATH}/{thread['id']}", json={"title": "Renamed"})
    assert renamed.status_code == 200 and renamed.json()["title"] == "Renamed"
    assert [item["id"] for item in (await http_client.get(THREAD_PATH)).json()] == [thread["id"]]

    assert (await http_client.delete(f"{THREAD_PATH}/{thread['id']}")).status_code == 204
    assert (await http_client.get(THREAD_PATH)).json() == []


@pytest.mark.asyncio
async def test_thread_routes_reject_removed_origins_and_sanitize_not_found(http_client):
    for body in (
        {},
        {"title": ""},
        {"title": "x", "project_snapshot_key": "0" * 64},
        {"title": "x", "moment_fingerprint": "0" * 64},
    ):
        assert (await http_client.post(THREAD_PATH, json=body)).status_code == 422, body

    opaque = uuid.uuid4().hex
    for method in ("get", "delete"):
        response = await getattr(http_client, method)(f"{THREAD_PATH}/{opaque}")
        assert response.status_code == 404
        assert opaque not in response.text
    response = await http_client.patch(f"{THREAD_PATH}/{opaque}", json={"title": "x"})
    assert response.status_code == 404


@pytest.mark.parametrize(
    "path",
    [
        "/api/personal-chief/briefing",
        "/api/chief/moments",
        "/api/chief/activity/projects",
    ],
)
def test_removed_chief_routes_are_gone(path):
    assert path not in {getattr(route, "path", None) for route in main.app.routes}
