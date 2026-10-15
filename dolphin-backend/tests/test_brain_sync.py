"""Bringing every machine's work home (app/brain_sync.py).

A fake brain stands in for GBrain with the behaviour the sync relies on, each
checked against the real one: put_page replaces a page whole (timeline
included), get_page on a missing page says page_not_found, a duplicate fact is
skipped, and the whole brain is unavailable while another process holds it.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app import brain, brain_sync
from app.database import Base
from app.models import Notification, Project


class FakeBrain:
    def __init__(self):
        self.pages: dict[str, dict] = {}
        self.facts: list[dict] = []
        self.calls: list[str] = []
        self.busy = False
        self.delta = {"facts": [], "pages": [], "has_more": False, "next_cursor": {"cursor": "c1"}}

    def call(self, tool, arguments, timeout=None):
        if self.busy:
            raise brain.BrainBusy("GBrain's local database is already open")
        self.calls.append(tool)
        if tool == "put_page":
            content = arguments["content"]
            body, _, timeline = content.partition("\n## Timeline\n")
            self.pages[arguments["slug"]] = {"content": content, "timeline": ("## Timeline\n" + timeline) if timeline else "",
                                             "frontmatter": {}}
            return {"status": "created_or_updated"}
        if tool == "get_page":
            if arguments["slug"] not in self.pages:
                raise brain.BrainNotFound("Page not found")
            return self.pages[arguments["slug"]]
        if tool == "remember":
            for item in arguments["items"]:
                if not any(f["fact"] == item["fact"] and f.get("entity") == item.get("entity") for f in self.facts):
                    self.facts.append(item)
            return {"saved": len(arguments["items"])}
        if tool == "delta":
            self.last_delta_args = arguments
            return self.delta
        raise AssertionError(tool)


@pytest.fixture
def fake(tmp_path, monkeypatch):
    monkeypatch.setenv("DOLPHIN_HOME", str(tmp_path / "dolphin"))
    fake = FakeBrain()
    monkeypatch.setattr(brain, "call", fake.call)
    monkeypatch.setattr(brain, "ready", lambda: True)
    return fake


@pytest_asyncio.fixture
async def factory():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    yield async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    await engine.dispose()


async def _seed(factory, turns: int = 2):
    start = datetime(2026, 10, 15, 3, 0, tzinfo=timezone.utc)
    async with factory() as db:
        db.add_all([
            Project(id="p1", name="Atlas Studio", path="/home/me/atlas-studio", position=0),
            Project(id="p2", name="Inbox", is_inbox=True, position=1),
            Project(id="p3", name="hidden root", path="/home/me", is_hidden=True, position=2),
        ])
        db.add_all([
            Notification(id=f"n{i}", turn_id=f"t{i}", provider="claude", project_id="p1", session_name="build",
                         pane_id="%1", summary=f"Step {i} done.", finished_at=start + timedelta(minutes=i),
                         created_at=start + timedelta(minutes=i))
            for i in range(turns)
        ])
        await db.commit()


@pytest.mark.asyncio
async def test_export_lists_projects_and_pages_through_finished_turns(fake, factory, monkeypatch):
    await _seed(factory, turns=3)
    monkeypatch.setattr(brain_sync, "TURN_LIMIT", 2)
    async with factory() as db:
        first = await brain_sync.export(db, {}, include_brain=False)
        second = await brain_sync.export(db, json.loads(json.dumps(first["cursor"])), include_brain=False)
        third = await brain_sync.export(db, second["cursor"], include_brain=False)
    assert [p["name"] for p in first["projects"]] == ["Atlas Studio", "Inbox"]  # the hidden root stays out
    assert [t["summary"] for t in first["turns"]] == ["Step 0 done.", "Step 1 done."] and first["has_more"]
    assert [t["summary"] for t in second["turns"]] == ["Step 2 done."] and not second["has_more"]
    assert third["turns"] == [] and third["cursor"]["turns"] == second["cursor"]["turns"]
    assert first["brain"] == "off" and fake.calls == []


@pytest.mark.asyncio
async def test_export_carries_the_brain_but_never_what_a_sync_wrote(fake, factory):
    fake.delta = {
        "facts": [{"fact": "Uses uv", "kind": "preference", "entity_slug": "user", "provenance": "said so"},
                  {"fact": "Came from elsewhere", "kind": "fact", "entity_slug": "user", "provenance": "via Dolphin from laptop: x"}],
        "pages": [{"slug": "notes/deploy"}, {"slug": "machines/laptop"}, {"slug": "projects/laptop/atlas"}],
        "has_more": True, "next_cursor": {"cursor": "c2"},
    }
    fake.pages["notes/deploy"] = {"title": "Deploy", "type": "note", "compiled_truth": "Use fly.", "timeline": "", "frontmatter": {}}
    fake.pages["projects/laptop/atlas"] = {"title": "Atlas", "compiled_truth": "", "frontmatter": {"dolphin_machine": "laptop"}}
    async with factory() as db:
        result = await brain_sync.export(db, {"brain": "c1"}, include_brain=True)
    assert fake.last_delta_args["cursor"] == "c1"
    assert [f["fact"] for f in result["facts"]] == ["Uses uv"]
    assert [p["slug"] for p in result["pages"]] == ["notes/deploy"]
    assert result["cursor"]["brain"] == "c2" and result["has_more"] and result["brain"] == "ready"


@pytest.mark.asyncio
async def test_a_busy_brain_still_exports_work_and_keeps_its_cursor(fake, factory):
    await _seed(factory)
    fake.busy = True
    async with factory() as db:
        result = await brain_sync.export(db, {"brain": "c1"}, include_brain=True)
    assert result["brain"] == "busy" and result["cursor"]["brain"] == "c1"
    assert len(result["turns"]) == 2


async def _export(factory, fake):
    fake.delta = {"facts": [{"fact": "Prefers pnpm", "kind": "idea", "entity_slug": "user", "provenance": "chat"}],
                  "pages": [{"slug": "notes/deploy"}], "has_more": False, "next_cursor": {"cursor": "c9"}}
    fake.pages["notes/deploy"] = {"title": "Deploy", "type": "note", "compiled_truth": "Use fly.", "timeline": "", "frontmatter": {}}
    async with factory() as db:
        return await brain_sync.export(db, {}, include_brain=True)


@pytest.mark.asyncio
async def test_an_import_labels_everything_with_its_machine(fake, factory):
    await _seed(factory)
    body = await _export(factory, fake)
    fake.pages.clear()
    assert brain_sync.receive({"id": "gpu-box", "label": "gpu-box", "kind": "ssh"}, body) == {"pending": 0, "busy": False}

    machine = fake.pages["machines/gpu-box"]["content"]
    assert 'dolphin_machine: "gpu-box"' in machine and "[[projects/gpu-box/atlas-studio]] Atlas Studio — `/home/me/atlas-studio`" in machine
    project = fake.pages["projects/gpu-box/atlas-studio"]
    assert "Its folder is `/home/me/atlas-studio`." in project["content"]
    assert "- **2026-10-15** | gpu-box — 03:01 UTC, Claude in build: Step 1 done." in project["timeline"]
    assert "projects/gpu-box/inbox" in fake.pages
    assert fake.facts == [{"fact": "Prefers pnpm", "entity": "user", "kind": "fact", "provenance": "via Dolphin from gpu-box: chat"}]
    assert "Use fly." in fake.pages["machines/gpu-box/brain/notes/deploy"]["content"]


@pytest.mark.asyncio
async def test_importing_again_adds_only_what_is_new(fake, factory):
    await _seed(factory)
    body = await _export(factory, fake)
    fake.pages.clear()
    machine = {"id": "gpu-box", "label": "gpu-box", "kind": "ssh"}
    brain_sync.receive(machine, body)
    fake.calls.clear()
    brain_sync.receive(machine, body)
    # Unchanged pages are not written again; facts go to GBrain, which skips duplicates.
    assert "put_page" not in fake.calls
    assert len(fake.facts) == 1

    later = {**body, "turns": [{**body["turns"][0], "id": "n9", "summary": "Shipped it.", "finished_at": "2026-10-16T09:30:00+00:00"}],
             "facts": [], "pages": []}
    brain_sync.receive(machine, later)
    timeline = fake.pages["projects/gpu-box/atlas-studio"]["timeline"]
    assert timeline.count("Step 0 done.") == 1 and timeline.count("Step 1 done.") == 1
    assert timeline.strip().endswith("Claude in build: Shipped it.")


@pytest.mark.asyncio
async def test_a_busy_brain_keeps_the_import_and_writes_it_later(fake, factory):
    await _seed(factory)
    body = await _export(factory, fake)
    fake.pages.clear()
    fake.busy = True
    assert brain_sync.receive({"id": "gpu-box", "kind": "ssh"}, body) == {"pending": 1, "busy": True}
    assert fake.pages == {}
    fake.busy = False
    assert brain_sync.flush() == {"pending": 0, "busy": False}
    assert "projects/gpu-box/atlas-studio" in fake.pages and fake.facts


def test_the_import_endpoint_refuses_while_memory_is_off(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from app.main import app

    monkeypatch.setenv("DOLPHIN_HOME", str(tmp_path / "dolphin"))
    monkeypatch.setattr(brain, "ready", lambda: False)
    response = TestClient(app).post("/api/brain/import", json={"machine": {"id": "gpu-box"}, "export": {}})
    assert response.status_code == 409
