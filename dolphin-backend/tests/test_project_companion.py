"""A project companion: one conversation per project, scoped to that project.

The companion is the ordinary Dolphin agent on a thread whose
``project_fingerprint`` is ``companion:<project_id>``. Its thread stays out of
the main chat's list, its tools refuse other projects, and its suggestions
save nothing.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app import dolphin_agent, main
from app.chief_conversation_repository import ChiefConversationRepository, companion_project
from app.database import Base, get_db
from app.dolphin_agent_tools import DolphinTools, ToolError, tool_definitions
from app.models import Project


@pytest_asyncio.fixture
async def client(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'companion.db'}")
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    async with factory() as session:
        session.add(Project(id="alpha", name="Alpha", path="/tmp/alpha"))
        await session.commit()

    async def override():
        async with factory() as session:
            yield session

    main.app.dependency_overrides[get_db] = override
    try:
        async with AsyncClient(transport=ASGITransport(app=main.app), base_url="http://test") as http:
            yield http, factory
    finally:
        main.app.dependency_overrides.pop(get_db, None)
        await engine.dispose()


@pytest.mark.asyncio
async def test_each_project_keeps_one_companion_thread_outside_the_main_list(client):
    http, factory = client
    first = await http.post("/api/projects/alpha/companion")
    again = await http.post("/api/projects/alpha/companion")
    assert first.status_code == 200
    assert first.json()["id"] == again.json()["id"]
    assert first.json()["title"] == "Alpha"
    assert first.json()["messages"] == []
    ordinary = await http.post("/api/chief/threads", json={"title": "Hello"})
    listed = [t["id"] for t in (await http.get("/api/chief/threads")).json()]
    assert listed == [ordinary.json()["id"]]
    async with factory() as session:
        thread = await ChiefConversationRepository(session).get_thread(first.json()["id"])
    assert companion_project(thread.project_fingerprint) == "alpha"
    assert (await http.post("/api/projects/missing/companion")).status_code == 404


def test_only_companions_offer_suggestions():
    names = lambda defs: {d["function"]["name"] for d in defs}
    assert "suggest_tasks" not in names(tool_definitions())
    assert "suggest_tasks" in names(tool_definitions(companion=True))


@pytest.mark.asyncio
async def test_suggestions_save_nothing_and_skip_tasks_that_exist():
    tools = DolphinTools(None, None, "turn")
    calls = []

    async def api_call(method, path, **kwargs):
        calls.append(method)
        return [{"id": "t1", "title": "Write the docs", "is_done": False},
                {"id": "t2", "title": "Old", "is_done": True}]

    tools.api_call = api_call
    result = await tools.execute("suggest_tasks", {
        "project_id": "alpha", "next_task_id": "t1", "next_reason": "Blocks the release",
        "suggestions": [{"title": "write the docs", "why": "dup"}, {"title": "Add a test", "why": "No coverage"}],
    })
    assert calls == ["GET"]
    assert result["suggestions"] == [{"title": "Add a test", "why": "No coverage"}]
    assert result["next"] == {"task_id": "t1", "reason": "Blocks the release"}
    with pytest.raises(ToolError):
        await tools.execute("suggest_tasks", {"project_id": "alpha", "next_task_id": "t2"})


def _repository(fingerprint):
    return SimpleNamespace(
        begin_turn=AsyncMock(return_value=SimpleNamespace(response_bytes=None, should_generate=True, turn_request_id="turn", user_message_id="user")),
        list_recent_messages=AsyncMock(return_value=[]), complete_turn=AsyncMock(),
        get_thread=AsyncMock(return_value=SimpleNamespace(project_fingerprint=fingerprint)),
    )


@pytest.mark.asyncio
async def test_companion_is_scoped_to_its_project(monkeypatch):
    seen = {}
    results = []

    async def complete(messages, tools, preferred, on_text=None):
        if "prompt" not in seen:
            seen["prompt"] = messages[0]["content"]
            seen["tools"] = {t["function"]["name"] for t in tools}
            seen["observed"] = messages[-2]["content"]
            return {"content": None, "tool_calls": [
                {"id": "c1", "function": {"name": "create_task", "arguments": '{"project_id": "beta", "title": "x", "description": "y"}'}},
            ]}, {"provider": "claude"}
        results.append(messages[-1]["content"])
        return {"content": "Done.", "tool_calls": []}, {"provider": "claude"}

    async def execute(tools, name, args):
        if name == "list_projects":
            return {"result": [{"id": "alpha", "name": "Alpha"}]}
        return {"result": {"name": name}}

    executed = AsyncMock(side_effect=execute)
    monkeypatch.setattr(dolphin_agent, "complete", complete)
    monkeypatch.setattr(dolphin_agent, "execute_recorded", executed)
    monkeypatch.setattr(dolphin_agent, "receipts", AsyncMock(return_value=[]))
    reply = await dolphin_agent.run_agent(_repository("companion:alpha"), "thread", "Plan my afternoon", "key", None)
    assert reply["display_text"] == "Done."
    assert "COMPANION FOR ONE PROJECT: Alpha (project_id alpha)" in seen["prompt"]
    assert "suggest_tasks" in seen["tools"]
    assert "project_status" in seen["observed"] and "list_sessions" in seen["observed"]
    assert "works only on project alpha" in results[0]
    calls = [(c.args[1], c.args[2]) for c in executed.await_args_list]
    assert ("project_status", {"project_id": "alpha"}) in calls
    assert ("list_sessions", {"project_id": "alpha"}) in calls
    assert all(name != "create_task" for name, _ in calls)


@pytest.mark.asyncio
async def test_main_chat_cannot_call_companion_tools(monkeypatch):
    answers = []

    async def complete(messages, tools, preferred, on_text=None):
        if not answers:
            answers.append({t["function"]["name"] for t in tools})
            return {"content": None, "tool_calls": [
                {"id": "c1", "function": {"name": "suggest_tasks", "arguments": '{"project_id": "alpha"}'}},
            ]}, {"provider": "claude"}
        answers.append(messages[-1]["content"])
        return {"content": "Ok.", "tool_calls": []}, {"provider": "claude"}

    executed = AsyncMock(return_value={"result": []})
    monkeypatch.setattr(dolphin_agent, "complete", complete)
    monkeypatch.setattr(dolphin_agent, "execute_recorded", executed)
    monkeypatch.setattr(dolphin_agent, "receipts", AsyncMock(return_value=[]))
    await dolphin_agent.run_agent(_repository(None), "thread", "Hi", "key", None)
    assert "suggest_tasks" not in answers[0]
    assert "Unknown tool" in answers[1]
    assert all(c.args[1] not in ("suggest_tasks", "project_status") for c in executed.await_args_list)
