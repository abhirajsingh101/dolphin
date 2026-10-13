"""Event-driven turn updates: a nudge wakes the collector, turn-state changes go
out on the stream as `turn` events, and helper mode scans every 30 s otherwise."""

import asyncio
import contextlib
from datetime import datetime, timedelta, timezone

import pytest
from httpx import ASGITransport, AsyncClient

from app import turn_notifications


async def _until(predicate, timeout: float = 2.0):
    deadline = asyncio.get_running_loop().time() + timeout
    while not predicate():
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError("condition never became true")
        await asyncio.sleep(0.01)


@contextlib.asynccontextmanager
async def _no_db():
    yield None


@pytest.mark.asyncio
async def test_turn_state_changes_are_published_once_each(monkeypatch):
    states: dict = {}

    async def pane_states():
        return dict(states)

    invalidated: list = []
    monkeypatch.setattr(turn_notifications, "_pane_states", pane_states)
    monkeypatch.setattr(turn_notifications.tmux_service, "_invalidate_sessions_cache", lambda: invalidated.append(1))
    broadcaster = turn_notifications.Broadcaster()
    queue = broadcaster.subscribe()
    tracker = turn_notifications.TurnStates()
    at = datetime(2026, 10, 12, 8, tzinfo=timezone.utc)

    states["%1"] = ("alpha", "finished", at)
    assert await tracker.scan(broadcaster) == []  # the first scan is the baseline
    states["%1"] = ("alpha", "working", at + timedelta(seconds=5))
    [item] = await tracker.scan(broadcaster)
    assert item == {"kind": "turn_state", "pane_id": "%1", "session_name": "alpha",
                    "turn_state": "working", "turn_at": "2026-10-12T08:00:05+00:00"}
    assert await tracker.scan(broadcaster) == []  # unchanged: nothing new
    assert queue.get_nowait() == item and queue.empty()
    assert invalidated == [1]  # the next control-center read sees the change


@pytest.mark.asyncio
async def test_the_stream_names_turn_events():
    broadcaster = turn_notifications.Broadcaster()
    stream = turn_notifications.event_stream(broadcaster, heartbeat_seconds=5)
    assert await anext(stream) == ": connected\n\n"
    broadcaster.publish({"kind": "turn_state", "session_name": "alpha"})
    assert await anext(stream) == 'event: turn\ndata: {"kind": "turn_state", "session_name": "alpha"}\n\n'
    broadcaster.publish({"kind": "turn_end", "id": "n1"})
    assert await anext(stream) == 'event: notification\ndata: {"kind": "turn_end", "id": "n1"}\n\n'
    await stream.aclose()


@pytest.mark.asyncio
async def test_a_nudge_scans_at_once_and_helper_mode_falls_back_to_30_seconds(monkeypatch):
    monkeypatch.setenv("DOLPHIN_HELPER_VERSION", "0.1.11")
    assert turn_notifications.scan_interval() == 30.0
    monkeypatch.delenv("DOLPHIN_HELPER_VERSION")
    assert turn_notifications.scan_interval() == 2.0

    scans: list = []

    async def scan_once(_factory, _broadcaster):
        scans.append(1)
        return []

    async def pane_states():
        return {}

    async def prune(_db, **_kwargs):
        return None

    monkeypatch.setattr(turn_notifications, "scan_once", scan_once)
    monkeypatch.setattr(turn_notifications, "_pane_states", pane_states)
    monkeypatch.setattr(turn_notifications, "prune", prune)
    monkeypatch.setattr(turn_notifications, "scan_interval", lambda: 60.0)
    collector = turn_notifications.Collector(_no_db, turn_notifications.Broadcaster())
    collector.start()
    try:
        await _until(lambda: len(scans) == 1)
        await asyncio.sleep(0.05)
        assert len(scans) == 1  # nothing before the 60 s fallback
        turn_notifications.wake()
        await _until(lambda: len(scans) == 2)
    finally:
        await collector.stop()
    turn_notifications.wake()  # a stopped collector is no longer woken
    await asyncio.sleep(0.02)
    assert len(scans) == 2


@pytest.mark.asyncio
async def test_the_nudge_endpoint_wakes_the_collector_in_helper_mode_only(monkeypatch):
    from app import main

    woken: list = []
    monkeypatch.setattr(turn_notifications, "wake", lambda: woken.append(1))
    async with AsyncClient(transport=ASGITransport(app=main.app), base_url="http://test") as http:
        monkeypatch.delenv("DOLPHIN_HELPER_VERSION", raising=False)
        assert (await http.post("/api/desktop/turn-nudge")).status_code == 404
        monkeypatch.setenv("DOLPHIN_HELPER_VERSION", "0.1.11")
        response = await http.post("/api/desktop/turn-nudge")
    assert response.status_code == 204 and woken == [1]
