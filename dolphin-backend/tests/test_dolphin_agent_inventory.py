"""The chat agent's project inventory: each project's id, name and folder, plus
whatever the personal extensions add when they are installed."""

from __future__ import annotations

import httpx
import pytest

from app.dolphin_agent_tools import EXTENSION, DolphinTools


@pytest.mark.asyncio
async def test_list_projects_returns_id_name_and_path():
    rows = [
        {"id": "p1", "name": "Studio", "path": "/home/user/projects/studio", "emoji": "x"},
        {"id": "p2", "name": "Inbox", "path": None},
    ]
    transport = httpx.MockTransport(lambda request: httpx.Response(200, json=rows))
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as api:
        tools = DolphinTools(api, dispatch=None, turn_id="turn")
        result = await tools.execute("list_projects", {})

    expected = [
        {"id": "p1", "name": "Studio", "path": "/home/user/projects/studio"},
        {"id": "p2", "name": "Inbox", "path": None},
    ]
    if EXTENSION:
        expected = [{**row, **EXTENSION.project_extra(row)} for row in expected]
    assert result == expected
