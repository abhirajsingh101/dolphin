"""Turn-end notifications: hook → tmux pane option → collector → rows → API.

Uses only disposable tmux sessions; never a model.
"""
import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path
from uuid import uuid4

import pytest
import pytest_asyncio

from app.tmux_service import _run_tmux

BACKEND = Path(__file__).resolve().parents[1]
# The hook as agents run it: Dolphin's hook command is a thin launcher for this module.
HOOK = [sys.executable, "-m", "app.agent_hook"]


async def _disposable_session(path="/tmp"):
    name = "dolphin-notify-test-" + uuid4().hex[:10]
    await _run_tmux("new-session", "-d", "-s", name, "-c", path)
    _, pane, _ = await _run_tmux("display-message", "-p", "-t", name + ":0.0", "#{pane_id}")
    return name, pane.strip()


def _run_hook(pane: str, provider: str, event: str, payload: dict) -> subprocess.CompletedProcess:
    environ = {**os.environ, "TMUX_PANE": pane}
    return subprocess.run(
        [*HOOK, "--provider", provider, "--event", event],
        input=json.dumps(payload).encode(), env=environ, capture_output=True, timeout=10, cwd=BACKEND,
    )


async def _agent_turn(pane: str, provider: str, payload: dict, tmp_path: Path, *, detached: bool = False) -> None:
    """Run the hook the way a real agent does: from a process named codex/claude
    started in the pane, so it has the pane's terminal. ``detached`` starts the
    same agent with setsid, like a backgrounded daemon or research run that
    still inherits TMUX_PANE."""
    work = tmp_path / uuid4().hex[:8]
    work.mkdir()
    (work / "payload.json").write_text(json.dumps(payload))
    agent = work / provider
    agent.write_text(f'#!/bin/bash\ncd "{BACKEND}" && "{sys.executable}" -m app.agent_hook --provider {provider} --event stop < "{work}/payload.json" > "{work}/out"\ntouch "{work}/done"\n')
    agent.chmod(0o755)
    command = f"setsid {agent} < /dev/null > /dev/null 2>&1 &" if detached else str(agent)
    await _run_tmux("send-keys", "-t", pane, command, "Enter")
    for _ in range(100):
        if (work / "done").exists():
            return
        await asyncio.sleep(0.1)
    raise AssertionError("the fake agent never ran")


async def _turn_option(pane: str) -> str:
    _, raw, _ = await _run_tmux("show-options", "-p", "-qv", "-t", pane, "@dolphin-turn", check=False)
    return raw.strip()


@pytest.mark.asyncio
@pytest.mark.parametrize("provider", ["claude", "codex"])
async def test_stop_records_the_turn_of_the_panes_own_agent(provider, tmp_path):
    name, pane = await _disposable_session()
    try:
        reply = "Done.\n\n  Wrote report.md   and ran the tests. " + "x" * 400
        await _agent_turn(pane, provider, {"session_id": "s", "cwd": "/tmp", "last_assistant_message": reply}, tmp_path)
        turn = json.loads(await _turn_option(pane))
        assert turn["provider"] == provider
        assert len(turn["id"]) == 32 and turn["finished_at"]
        assert turn["summary"].startswith("Done. Wrote report.md and ran the tests. x")
        assert len(turn["summary"]) == 300
        first = turn["id"]
        await _agent_turn(pane, provider, {"session_id": "s", "cwd": "/tmp"}, tmp_path)
        second = json.loads(await _turn_option(pane))
        assert second["id"] != first and second["summary"] == ""
    finally:
        await _run_tmux("kill-session", "-t", name, check=False)


@pytest.mark.asyncio
@pytest.mark.parametrize("provider", ["claude", "codex"])
async def test_hook_output_is_a_valid_no_op(provider):
    name, pane = await _disposable_session()
    try:
        result = _run_hook(pane, provider, "stop", {"session_id": "s", "cwd": "/tmp", "last_assistant_message": "x"})
        assert result.returncode == 0 and result.stderr == b""
        assert result.stdout == (b"{}\n" if provider == "codex" else b"")
    finally:
        await _run_tmux("kill-session", "-t", name, check=False)


@pytest.mark.asyncio
async def test_detached_agents_that_inherited_the_pane_are_not_its_turns(tmp_path):
    """A Codex daemon or backgrounded research run started from a pane keeps
    TMUX_PANE but has no terminal; its turns are not the pane's work."""
    name, pane = await _disposable_session()
    try:
        await _agent_turn(pane, "codex", {"session_id": "s", "cwd": "/tmp", "last_assistant_message": "Slurm ready"}, tmp_path, detached=True)
        assert await _turn_option(pane) == ""
        # Not this pane's terminal either: run from pytest, whose agent is elsewhere.
        _run_hook(pane, "claude", "stop", {"session_id": "s", "cwd": "/tmp", "last_assistant_message": "x"})
        assert await _turn_option(pane) == ""
    finally:
        await _run_tmux("kill-session", "-t", name, check=False)


@pytest.mark.asyncio
async def test_prompt_submit_records_nothing():
    name, pane = await _disposable_session()
    try:
        _run_hook(pane, "claude", "user_prompt_submit", {"session_id": "s", "cwd": "/tmp", "prompt": "hi"})
        assert await _turn_option(pane) == ""
    finally:
        await _run_tmux("kill-session", "-t", name, check=False)


def test_hook_stays_silent_outside_tmux():
    result = _run_hook("%999999", "codex", "stop", {"session_id": "s", "cwd": "/tmp", "last_assistant_message": "x"})
    assert result.returncode == 0 and result.stdout == b"{}\n" and result.stderr == b""


# --- Collector ---------------------------------------------------------------

from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app import turn_notifications
from app.database import Base
from app.models import Notification, Project


@pytest_asyncio.fixture
async def factory():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    yield async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    await engine.dispose()


async def _set_turn(pane: str, turn: dict):
    await _run_tmux("set-option", "-p", "-t", pane, "@dolphin-turn", json.dumps(turn))


def _turn(**overrides):
    return {"id": uuid4().hex, "provider": "codex", "finished_at": "2026-10-07T08:00:00+00:00",
            "summary": "Tests pass.", **overrides}


@pytest.mark.asyncio
async def test_scan_records_each_turn_once_under_the_deepest_project(factory, tmp_path):
    outer, inner = tmp_path / "work", tmp_path / "work" / "app"
    (inner / "src").mkdir(parents=True)
    async with factory() as db:
        db.add_all([Project(id="outer", name="Outer", path=str(outer)),
                    Project(id="inner", name="Inner", path=str(inner))])
        await db.commit()
    name, pane = await _disposable_session(str(inner / "src"))
    try:
        turn = _turn()
        await _set_turn(pane, turn)
        published = []
        broadcaster = turn_notifications.Broadcaster()
        queue = broadcaster.subscribe()
        items = await turn_notifications.scan_once(factory, broadcaster)
        mine = [item for item in items if item["turn_id"] == turn["id"]]
        assert len(mine) == 1
        assert mine[0]["project_id"] == "inner" and mine[0]["project_name"] == "Inner"
        assert mine[0]["session_name"] == name and mine[0]["pane_id"] == pane
        assert mine[0]["summary"] == "Tests pass." and mine[0]["read"] is False
        while not queue.empty():
            published.append(queue.get_nowait())
        assert turn["id"] in {item["turn_id"] for item in published}
        again = await turn_notifications.scan_once(factory, broadcaster)
        assert turn["id"] not in {item["turn_id"] for item in again}
        async with factory() as db:
            assert await db.scalar(select(func.count()).where(Notification.turn_id == turn["id"])) == 1
    finally:
        await _run_tmux("kill-session", "-t", name, check=False)


@pytest.mark.asyncio
async def test_scan_keeps_unmatched_sessions_and_skips_malformed_turns(factory):
    name, pane = await _disposable_session("/")
    other_name, other_pane = await _disposable_session("/")
    try:
        turn = _turn(provider="claude")
        await _set_turn(pane, turn)
        await _run_tmux("set-option", "-p", "-t", other_pane, "@dolphin-turn", "not json")
        items = await turn_notifications.scan_once(factory, turn_notifications.Broadcaster())
        mine = [item for item in items if item["session_name"] in {name, other_name}]
        assert [(item["turn_id"], item["project_id"]) for item in mine] == [(turn["id"], None)]
    finally:
        await _run_tmux("kill-session", "-t", name, check=False)
        await _run_tmux("kill-session", "-t", other_name, check=False)


@pytest.mark.asyncio
async def test_prune_trims_by_age_and_count(factory):
    now = datetime(2026, 10, 7, tzinfo=timezone.utc)
    async with factory() as db:
        for index in range(6):
            db.add(Notification(turn_id=f"t{index}", provider="codex", session_name="s", pane_id="%1",
                                finished_at=now, created_at=now - timedelta(minutes=index)))
        db.add(Notification(turn_id="old", provider="codex", session_name="s", pane_id="%1",
                            finished_at=now, created_at=now - timedelta(days=8)))
        await db.commit()
        await turn_notifications.prune(db, now=now, keep=4)
        kept = (await db.scalars(select(Notification.turn_id).order_by(Notification.created_at.desc()))).all()
    assert kept == ["t0", "t1", "t2", "t3"]


@pytest.mark.asyncio
async def test_broadcaster_fans_out_and_forgets_unsubscribed_queues():
    broadcaster = turn_notifications.Broadcaster()
    first, second = broadcaster.subscribe(), broadcaster.subscribe()
    broadcaster.unsubscribe(second)
    broadcaster.publish({"id": "n"})
    assert first.get_nowait() == {"id": "n"} and second.empty()


# --- API and stream ----------------------------------------------------------

from httpx import ASGITransport, AsyncClient

from app import main
from app.database import get_db


@pytest_asyncio.fixture
async def client(factory):
    async def override_get_db():
        async with factory() as session:
            yield session

    main.app.dependency_overrides[get_db] = override_get_db
    try:
        async with AsyncClient(transport=ASGITransport(app=main.app), base_url="http://test") as http:
            yield http
    finally:
        main.app.dependency_overrides.pop(get_db, None)


async def _seed(factory):
    base = datetime(2026, 10, 7, 8, tzinfo=timezone.utc)
    async with factory() as db:
        db.add(Project(id="p", name="Orbit", path="/tmp/orbit"))
        for index, (turn_id, project) in enumerate([("a", "p"), ("b", None), ("c", "p")]):
            # Collected in one scan, so the finish time decides the order.
            db.add(Notification(turn_id=turn_id, provider="claude", project_id=project, session_name=f"s-{turn_id}",
                                pane_id="%1", summary=f"turn {turn_id}", finished_at=base + timedelta(minutes=index),
                                created_at=base))
        await db.commit()


@pytest.mark.asyncio
async def test_list_and_mark_read(client, factory):
    await _seed(factory)
    listing = (await client.get("/api/notifications")).json()
    assert [item["turn_id"] for item in listing["items"]] == ["c", "b", "a"]
    assert listing["unread_count"] == 3
    assert listing["items"][0]["project_name"] == "Orbit" and listing["items"][1]["project_name"] is None
    first = listing["items"][0]["id"]
    marked = await client.post("/api/notifications/read", json={"ids": [first]})
    assert marked.status_code == 200 and marked.json() == {"unread_count": 2}
    assert (await client.get("/api/notifications", params={"limit": 1})).json()["items"][0]["read"] is True
    assert (await client.post("/api/notifications/read", json={"all": True})).json() == {"unread_count": 0}
    assert (await client.post("/api/notifications/read", json={})).status_code == 422


@pytest.mark.asyncio
async def test_stream_sends_published_items_and_heartbeats():
    broadcaster = turn_notifications.Broadcaster()
    stream = turn_notifications.event_stream(broadcaster, heartbeat_seconds=0.05)
    assert await anext(stream) == ": connected\n\n"
    broadcaster.publish({"id": "n1", "summary": "line\nbreak"})
    assert await anext(stream) == 'event: notification\ndata: {"id": "n1", "summary": "line\\nbreak"}\n\n'
    assert await anext(stream) == ": ping\n\n"
    await stream.aclose()
    assert not broadcaster._queues


@pytest.mark.asyncio
async def test_a_new_turn_marks_the_projects_earlier_turns_read(factory, monkeypatch, tmp_path):
    # The bell counts each project once: its newest turn. Earlier unread turns
    # from the same project, stored before or found in the same scan, become read;
    # other projects are untouched. A turn with no project falls back to its session.
    atlas, docs = tmp_path / "atlas", tmp_path / "docs"
    atlas.mkdir()
    docs.mkdir()
    async with factory() as db:
        db.add_all([Project(id="atlas", name="Atlas", path=str(atlas)), Project(id="docs", name="Docs", path=str(docs))])
        await db.commit()
    at = lambda minute: datetime(2026, 10, 9, 8, minute, tzinfo=timezone.utc)  # noqa: E731
    turns: list = []

    async def pane_turns():
        return list(turns)

    monkeypatch.setattr(turn_notifications, "_pane_turns", pane_turns)
    broadcaster = turn_notifications.Broadcaster()

    turns[:] = [("%1", "atlas-build", str(atlas), {"id": "a1", "provider": "codex", "finished_at": at(1), "summary": ""}),
                ("%2", "docs-main", str(docs), {"id": "d1", "provider": "codex", "finished_at": at(2), "summary": ""}),
                ("%9", "scratch", "/", {"id": "s1", "provider": "codex", "finished_at": at(3), "summary": ""})]
    await turn_notifications.scan_once(factory, broadcaster)

    # A later scan: Atlas finishes twice (another session of the same project),
    # and the unmatched session once more.
    turns[:] = [("%3", "atlas-docs", str(atlas), {"id": "a2", "provider": "claude", "finished_at": at(5), "summary": ""}),
                ("%1", "atlas-build", str(atlas), {"id": "a3", "provider": "codex", "finished_at": at(6), "summary": ""}),
                ("%9", "scratch", "/", {"id": "s2", "provider": "codex", "finished_at": at(7), "summary": ""})]
    items = {item["turn_id"]: item for item in await turn_notifications.scan_once(factory, broadcaster)}
    assert items["a2"]["read"] is True and items["a3"]["read"] is False and items["s2"]["read"] is False

    async with factory() as db:
        unread = set((await db.scalars(select(Notification.turn_id).where(Notification.read_at.is_(None)))).all())
    assert unread == {"a3", "d1", "s2"}
