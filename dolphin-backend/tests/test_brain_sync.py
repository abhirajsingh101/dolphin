"""Bringing every machine's work home (app/brain_sync.py).

A fake brain stands in for GBrain with the behaviour the sync relies on, each
checked against the real one: put_page replaces a page whole (timeline
included), get_page on a missing page says page_not_found, a duplicate fact is
skipped, and the whole brain is unavailable while another process holds it.
"""

from __future__ import annotations

import json
import time
from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app import brain, brain_sync, transcript_exchanges
from app.database import Base
from app.models import AgentExchange, Notification, Project


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
            kept = self.pages.get(arguments["slug"], {}).get("timeline", "")
            # A local writer's page with no Timeline section keeps the timeline it has.
            self.pages[arguments["slug"]] = {"content": content, "timeline": ("## Timeline\n" + timeline) if timeline else kept,
                                             "frontmatter": {}}
            return {"status": "created_or_updated"}
        if tool == "add_timeline_entry":
            page = self.pages.get(arguments["slug"])
            if page is None:
                raise brain.BrainNotFound("Page not found")
            line = f"- **{arguments['date']}** | {arguments['source']} — {arguments['summary']}"
            if line in page["timeline"].splitlines():
                return {"status": "skipped", "reason": "duplicate"}
            page["timeline"] = (page["timeline"] or "## Timeline\n") + "\n" + line
            return {"status": "created"}
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
    # Never the real agents' transcripts: empty scratch homes for both.
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude"))
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "codex"))
    monkeypatch.setattr(transcript_exchanges, "MIN_SCAN_INTERVAL", 0.0)
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
        db.add_all([
            AgentExchange(id=f"e{i}", key=f"claude:s1:{i}", agent="claude", session_id="s1", cwd="/home/me/atlas-studio",
                          folder="/home/me/atlas-studio", project_id="p1", prompt=f"Do step {i}", reply=f"Step {i} done.",
                          started_at=start + timedelta(minutes=i), finished_at=start + timedelta(minutes=i),
                          created_at=start + timedelta(minutes=i))
            for i in range(turns)
        ])
        await db.commit()


@pytest.mark.asyncio
async def test_export_lists_projects_and_pages_through_finished_turns(fake, factory, monkeypatch):
    await _seed(factory, turns=3)
    monkeypatch.setattr(brain_sync, "TURN_LIMIT", 2)
    async with factory() as db:
        first = await brain_sync.export(db, {})
        second = await brain_sync.export(db, json.loads(json.dumps(first["cursor"])))
        third = await brain_sync.export(db, second["cursor"])
    assert [p["name"] for p in first["projects"]] == ["Atlas Studio", "Inbox"]  # the hidden root stays out
    assert [t["summary"] for t in first["turns"]] == ["Step 0 done.", "Step 1 done."] and first["has_more"]
    assert [t["summary"] for t in second["turns"]] == ["Step 2 done."] and not second["has_more"]
    assert third["turns"] == [] and third["cursor"]["turns"] == second["cursor"]["turns"]
    assert "facts" not in first and fake.calls == []


async def _export(factory, fake):
    async with factory() as db:
        return await brain_sync.export(db, {})


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
    assert "[[projects/gpu-box/atlas-studio/2026-10]]" in project["content"]
    log = fake.pages["projects/gpu-box/atlas-studio/2026-10"]
    assert "- **2026-10-15** | gpu-box — 03:01 UTC, Claude: Do step 1 → Step 1 done." in log["timeline"]
    assert "work in October 2026" in log["content"] and 'aliases: ["Atlas Studio"]' in project["content"]
    assert "projects/gpu-box/inbox" in fake.pages
    assert not any(slug.startswith("machines/gpu-box/brain/") for slug in fake.pages)  # machines have no brains of their own


@pytest.mark.asyncio
async def test_importing_again_adds_only_what_is_new(fake, factory):
    await _seed(factory)
    body = await _export(factory, fake)
    fake.pages.clear()
    machine = {"id": "gpu-box", "label": "gpu-box", "kind": "ssh"}
    brain_sync.receive(machine, body)
    fake.calls.clear()
    brain_sync.receive(machine, body)
    # Unchanged pages are not written again; entries go to GBrain, which skips duplicates.
    assert "put_page" not in fake.calls

    later = {**body, "exchanges": [{**body["exchanges"][0], "id": "e9", "agent": "codex", "prompt": "Ship it",
                                    "reply": "Shipped it.", "finished_at": "2026-10-16T09:30:00+00:00"}],
             }
    brain_sync.receive(machine, later)
    timeline = fake.pages["projects/gpu-box/atlas-studio/2026-10"]["timeline"]
    assert timeline.count("Step 0 done.") == 1 and timeline.count("Step 1 done.") == 1
    assert timeline.strip().endswith("09:30 UTC, Codex: Ship it → Shipped it.")


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
    assert "projects/gpu-box/atlas-studio/2026-10" in fake.pages


def test_the_import_endpoint_refuses_while_memory_is_off(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from app.main import app

    monkeypatch.setenv("DOLPHIN_HOME", str(tmp_path / "dolphin"))
    monkeypatch.setattr(brain, "ready", lambda: False)
    response = TestClient(app).post("/api/brain/import", json={"machine": {"id": "gpu-box"}, "export": {}})
    assert response.status_code == 409


@pytest.mark.asyncio
async def test_exchanges_page_by_their_own_cursor(fake, factory, monkeypatch):
    await _seed(factory, turns=3)
    monkeypatch.setattr(brain_sync, "EXCHANGE_LIMIT", 2)
    async with factory() as db:
        first = await brain_sync.export(db, {})
        second = await brain_sync.export(db, json.loads(json.dumps(first["cursor"])))
    assert [e["prompt"] for e in first["exchanges"]] == ["Do step 0", "Do step 1"] and first["has_more"]
    assert [e["prompt"] for e in second["exchanges"]] == ["Do step 2"] and not second["has_more"]


def test_a_helper_older_than_exchanges_still_brings_its_turns(fake):
    body = {"hostname": "old", "projects": [{"id": "p1", "name": "Atlas", "path": "/a", "inbox": False}],
            "turns": [{"id": "n1", "project_id": "p1", "provider": "codex", "session": "build", "summary": "Done.",
                       "finished_at": "2026-10-15T03:00:00+00:00"}]}
    brain_sync.receive({"id": "old-box", "kind": "ssh"}, body)
    assert "Codex in build: Done." in fake.pages["projects/old-box/atlas/2026-10"]["timeline"]


def _exchange(i, **extra):
    return {"id": f"x{i}", "project_id": None, "agent": "claude", "session_id": "s", "folder": "/srv/tools/scraper",
            "prompt": f"ask {i}", "reply": f"answer {i}", "started_at": "2026-10-15T03:00:00+00:00",
            "finished_at": f"2026-10-15T03:{i:02d}:00+00:00", **extra}


def test_work_outside_a_dolphin_project_gets_a_page_for_its_folder(fake):
    body = {"projects": [], "exchanges": [_exchange(1), _exchange(2, prompt="")]}
    brain_sync.receive({"id": "gpu-box", "kind": "ssh"}, body)
    page = fake.pages["projects/gpu-box/scraper"]
    assert "It is not a Dolphin project" in page["content"] and "`/srv/tools/scraper`" in page["content"]
    log = fake.pages["projects/gpu-box/scraper/2026-10"]["timeline"]
    assert "Claude: ask 1 → answer 1" in log and "Claude (continued): answer 2" in log

def test_each_month_has_its_own_work_log_and_the_page_links_them(fake):
    body = {"projects": [], "exchanges": [_exchange(1), _exchange(2, finished_at="2026-11-02T08:00:00+00:00")]}
    brain_sync.receive({"id": "gpu-box", "kind": "ssh"}, body)
    assert "ask 1" in fake.pages["projects/gpu-box/scraper/2026-10"]["timeline"]
    assert "ask 2" in fake.pages["projects/gpu-box/scraper/2026-11"]["timeline"]
    page = fake.pages["projects/gpu-box/scraper"]["content"]
    assert "[[projects/gpu-box/scraper/2026-11]], [[projects/gpu-box/scraper/2026-10]]" in page
    assert page.count("ask") == 0  # the page itself holds no exchanges


@pytest.mark.asyncio
async def test_a_quiet_project_gets_its_summary_and_the_overview(fake, monkeypatch):
    from app import brain_summaries

    asked = []

    async def model(prompt):
        asked.append(prompt)
        return {"state": "The scraper fetches pages nightly.", "open_threads": ["Add retries"],
                "decisions": ["2026-10-15: use httpx"], "one_line": "Nightly scraper, retries next."}

    monkeypatch.setattr(brain_summaries, "ask_model", model)
    brain_sync.receive({"id": "gpu-box", "kind": "ssh"}, {"projects": [], "exchanges": [_exchange(1), _exchange(2)]})
    overview = fake.pages["dolphin/now"]["content"]
    assert "[[projects/gpu-box/scraper]]" in overview and "no summary yet." in overview and "always_load: true" in overview

    assert await brain_summaries.run_once() == 0  # not quiet yet
    assert await brain_summaries.run_once(now=time.time() + brain_summaries.QUIET_SECONDS + 1) == 1
    assert '"asked": "ask 1"' in asked[0] and '"answered": "answer 2"' in asked[0]
    page = fake.pages["projects/gpu-box/scraper"]
    assert "## State\n\nThe scraper fetches pages nightly." in page["content"]
    assert "<!--- gbrain:facts:begin -->" in page["content"]
    assert "| 1 | Open: Add retries | commitment |" in page["content"]
    assert "| 2 | Decided: use httpx | event | 1.0 | private | medium | 2026-10-15 |" in page["content"]
    assert 'summary: "Nightly scraper, retries next."' in page["content"]
    assert "ask 1" in fake.pages["projects/gpu-box/scraper/2026-10"]["timeline"]
    assert "Nightly scraper, retries next." in fake.pages["dolphin/now"]["content"]
    assert brain_summaries.due(now=time.time() + 10_000) == []  # the queue is empty

    # The next sync keeps the summary on top.
    brain_sync.receive({"id": "gpu-box", "kind": "ssh"}, {"projects": [], "exchanges": [_exchange(3)]})
    page = fake.pages["projects/gpu-box/scraper"]
    assert "The scraper fetches pages nightly." in page["content"]
    assert "ask 3" in fake.pages["projects/gpu-box/scraper/2026-10"]["timeline"]


@pytest.mark.asyncio
async def test_without_claude_or_codex_the_page_says_why_it_has_no_summary(fake, monkeypatch):
    from app import brain_summaries

    async def unavailable(prompt):
        raise brain_summaries.Unavailable("none")

    monkeypatch.setattr(brain_summaries, "ask_model", unavailable)
    brain_sync.receive({"id": "gpu-box", "kind": "ssh"}, {"projects": [], "exchanges": [_exchange(1)]})
    await brain_summaries.run_once(now=time.time() + brain_summaries.MAX_WAIT_SECONDS + 1)
    page = fake.pages["projects/gpu-box/scraper"]
    assert "summaries need Claude Code or Codex" in page["content"]


@pytest.mark.asyncio
async def test_a_first_summary_reads_only_the_newest_exchanges(fake, monkeypatch):
    from app import brain_summaries

    asked = []

    async def model(prompt):
        asked.append(prompt)
        return {"state": "Going well.", "open_threads": [], "decisions": [], "one_line": "Fine."}

    monkeypatch.setattr(brain_summaries, "ask_model", model)
    monkeypatch.setattr(brain_summaries, "CHUNK_CHARS", 250)
    brain_sync.receive({"id": "gpu-box", "kind": "ssh"}, {"projects": [], "exchanges": [_exchange(i) for i in range(6)]})
    later = time.time() + brain_summaries.MAX_WAIT_SECONDS + 1
    assert await brain_summaries.run_once(now=later) == 1
    assert '"ask 5"' in asked[0] and '"ask 0"' not in asked[0]
    assert brain_summaries.due(now=later + 10_000) == []  # the older ones are only in the timeline

    brain_sync.receive({"id": "gpu-box", "kind": "ssh"}, {"projects": [], "exchanges": [_exchange(i) for i in range(6, 12)]})
    await brain_summaries.run_once(now=time.time() + brain_summaries.MAX_WAIT_SECONDS + 1)
    assert '"ask 6"' in asked[1] and '"ask 11"' not in asked[1]  # after that, oldest first


def test_the_overview_stays_a_small_index(fake):
    from app import brain_summaries

    many = {"projects": [], "exchanges": [_exchange(i, folder=f"/srv/tools/project-{i:03d}") for i in range(60)]}
    brain_sync.receive({"id": "gpu-box", "kind": "ssh"}, many)
    content = fake.pages["dolphin/now"]["content"]
    body = content.split("---\n", 2)[2]
    assert len(body) <= brain_summaries.OVERVIEW_CHARS and "older projects: see each machine's page." in body


def test_the_overview_is_an_ordinary_page_when_core_memory_is_full(fake, monkeypatch):
    original = fake.call

    def call(tool, arguments, timeout=None):
        if tool == "put_page" and "always_load: true" in arguments["content"]:
            raise brain.BrainError("GBrain put_page failed (core_budget_exceeded): over budget")
        return original(tool, arguments, timeout)

    monkeypatch.setattr(brain, "call", call)
    brain_sync.receive({"id": "gpu-box", "kind": "ssh"}, {"projects": [], "exchanges": [_exchange(1)]})
    content = fake.pages["dolphin/now"]["content"]
    assert "always_load" not in content and "[[projects/gpu-box/scraper]]" in content



def test_the_chat_reads_the_newest_part_of_a_long_work_log():
    from app.dolphin_agent_tools import TIMELINE_CHARS, _newest_timeline

    page = {"slug": "projects/m/p/2026-10", "timeline": "\n".join(f"- **2026-10-{i % 28 + 1:02d}** | m — entry {i} " + "x" * 80 for i in range(600))}
    kept = _newest_timeline(page)["timeline"]
    assert len(kept) <= TIMELINE_CHARS + 60 and kept.splitlines()[-1].startswith("- **") and "entry 599" in kept
    assert "older lines left out" in kept.splitlines()[0] and "entry 0 " not in kept
    assert _newest_timeline({"timeline": "- short"}) == {"timeline": "- short"}
