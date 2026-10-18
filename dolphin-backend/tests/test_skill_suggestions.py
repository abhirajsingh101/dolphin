"""Skill and plugin suggestions (app/skill_suggestions.py, app/suggestions_api.py).

Every test runs on a scratch HOME and DOLPHIN_HOME, with the network and the
model replaced: nothing here reads the real agent folders or leaves the machine.
"""

from __future__ import annotations

import json
import time
from datetime import datetime, timezone
from urllib.parse import parse_qs, urlparse

import pytest
from fastapi.testclient import TestClient

from app import brain, brain_summaries, skill_suggestions as ss

NOW = time.time()


def _iso(at: float) -> str:
    return datetime.fromtimestamp(at, timezone.utc).isoformat()


@pytest.fixture
def home(tmp_path, monkeypatch):
    user = tmp_path / "home"
    user.mkdir()
    monkeypatch.setenv("HOME", str(user))
    monkeypatch.setenv("DOLPHIN_HOME", str(tmp_path / "dolphin"))
    monkeypatch.delenv("CLAUDE_CONFIG_DIR", raising=False)
    monkeypatch.delenv("CODEX_HOME", raising=False)
    monkeypatch.setattr(brain, "ready", lambda: True)
    monkeypatch.setattr(ss, "PAUSE", 0)
    monkeypatch.setattr(ss, "_running", False)
    monkeypatch.setattr(ss, "_refresh_task", None)
    return user


def _write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(value if isinstance(value, str) else json.dumps(value))


def _brain(projects):
    """overview.json and summaries/ as brain_summaries keeps them."""
    overview = {}
    for slug, (title, last, state) in projects.items():
        overview[slug] = {"title": title, "last_activity": _iso(last), "one_line": f"{title} work."}
        _write(brain_summaries._summary_path(slug), {"state": state, "open_threads": ["Add more tests"],
                                                     "decisions": [], "one_line": f"{title} work."})
    _write(brain.base() / "overview.json", overview)


SEARCH = {
    "fastapi alembic": [
        {"id": "acme/py/fastapi-pro", "source": "acme/py", "skillId": "fastapi-pro", "name": "fastapi-pro", "installs": 2500},
        {"id": "acme/py/alembic-helper", "source": "acme/py", "skillId": "alembic-helper", "name": "alembic-helper", "installs": 400},
        {"id": "tiny/x/obscure", "source": "tiny/x", "skillId": "obscure", "name": "obscure", "installs": 12},
        {"id": "have/it/installed-one", "source": "have/it", "skillId": "installed-one", "name": "installed-one", "installs": 5000},
        {"id": "lock/repo/locked", "source": "lock/repo", "skillId": "locked", "name": "locked", "installs": 3000},
    ],
    "playwright e2e testing": [
        {"id": "acme/py/fastapi-pro", "source": "acme/py", "skillId": "fastapi-pro", "name": "fastapi-pro", "installs": 2500},
        {"id": "web/qa/playwright-e2e", "source": "web/qa", "skillId": "playwright-e2e", "name": "playwright-e2e", "installs": 7000},
        {"id": "gen/eral/best-practices", "source": "gen/eral", "skillId": "best-practices", "name": "best-practices", "installs": 99000},
        {"id": "old/one/seen-before", "source": "old/one", "skillId": "seen-before", "name": "seen-before", "installs": 800},
    ],
}

CLAUDE_MARKET = {"name": "claude-plugins-official", "plugins": [
    {"name": "playwright", "description": "Browser automation and end-to-end testing with Playwright.",
     "category": "testing", "homepage": "https://example.com/playwright", "author": {"name": "Example"}},
    {"name": "installed-plugin", "description": "Playwright testing helpers.", "category": "testing",
     "author": {"name": "Someone"}, "source": {"url": "https://example.com/installed.git"}},
    {"name": "unrelated", "description": "Spreadsheets.", "category": "productivity"},
]}
STATS = {"plugins": [{"plugin": "playwright@claude-plugins-official", "unique_installs": 1234}]}
CODEX_MARKET = {"name": "openai-curated", "plugins": [
    {"name": "playwright-testing", "source": {"source": "local", "path": "./plugins/playwright-testing"}, "category": "Testing"},
]}


class FakeWeb:
    def __init__(self, fail_search: int | None = None):
        self.calls: list[tuple[str, dict]] = []
        self.fail_search = fail_search

    async def __call__(self, url, headers, timeout=10):
        self.calls.append((url, headers))
        parsed = urlparse(url)
        if parsed.netloc == "skills.sh" and parsed.path == "/api/search":
            if self.fail_search:
                return self.fail_search, {}, ""
            query = parse_qs(parsed.query)["q"][0]
            return 200, {}, json.dumps({"skills": SEARCH.get(query, [])})
        if parsed.netloc == "skills.sh":
            name = parsed.path.rsplit("/", 1)[-1]
            return 200, {}, f'<html><meta property="og:description" content="About {name} &amp; more"/></html>'
        if "claude-plugins-official/main" in url:
            if headers.get("If-None-Match") == '"v1"':
                return 304, {}, ""
            return 200, {"etag": '"v1"'}, json.dumps(CLAUDE_MARKET)
        if "plugin-installs" in url:
            return 200, {}, json.dumps(STATS)
        if "openai/plugins" in url:
            return 200, {}, json.dumps(CODEX_MARKET)
        raise AssertionError(f"unexpected request {url}")


class FakeModel:
    def __init__(self, scores=None):
        self.prompts: list[str] = []
        self.scores = scores or {}

    async def __call__(self, prompt, schema):
        self.prompts.append(prompt)
        if schema is ss.QUERY_SCHEMA:
            return {"queries": [{"query": "FastAPI Alembic", "project": "projects/api"},
                                {"query": "playwright e2e testing", "project": "projects/web"},
                                {"query": "fastapi alembic", "project": "projects/api"}]}
        payload = json.loads(prompt.split("\n\n")[-1])
        self.candidates = [c["key"] for c in payload["candidates"]]
        return {"items": [{"key": key, "relevance": self.scores.get(key, 3), "reason": "Fits " + key + " " + "word " * 30,
                           "project": "projects/web" if "playwright" in key else "projects/api"}
                          for key in self.candidates] + [{"key": "skill:made/up/thing", "relevance": 10,
                                                          "reason": "x", "project": ""}]}


def _installed(home):
    _write(home / ".claude" / "skills" / "installed-one" / "SKILL.md", "x")
    _write(home / ".agents" / ".skill-lock.json", {"skills": {"locked": {"source": "lock/repo", "skillPath": "x"}}})
    _write(home / ".claude" / "plugins" / "installed_plugins.json", {"plugins": {"installed-plugin@claude-plugins-official": []}})
    _write(home / ".claude" / "settings.json", {"enabledPlugins": {"other@somewhere": True}})
    _write(home / ".codex" / "skills" / "codex-skill" / "SKILL.md", "x")
    _write(home / ".codex" / "config.toml", '[plugins."linear@openai-curated"]\nenabled = true\n')


def test_installed_reads_every_agent_folder_in_a_scratch_home(home, monkeypatch):
    _installed(home)
    found = ss.installed()
    assert {"installed-one", "locked", "codex-skill"} <= found["skills"]
    assert found["skill_ids"] == {"lock/repo/locked"}
    assert found["plugins"] == {"installed-plugin@claude-plugins-official", "other@somewhere", "linear@openai-curated"}

    other = home / "elsewhere"
    _write(other / "skills" / "moved" / "SKILL.md", "x")
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(other))
    assert "moved" in ss.installed()["skills"]


def test_installed_tolerates_a_bare_home(home):
    assert ss.installed() == {"skills": set(), "skill_ids": set(), "plugins": set()}


@pytest.mark.asyncio
async def test_a_run_suggests_the_relevant_new_items_only(home, monkeypatch):
    _installed(home)
    _brain({"projects/api": ("API", NOW - 3600, "A FastAPI backend with Alembic migrations."),
            "projects/web": ("Web", NOW - 7200, "A React app tested with Playwright."),
            "projects/old": ("Old", NOW - 10 * 86400, "Untouched for days.")})
    ss._update(lambda s: s.update(shown={"skill:old/one/seen-before": _iso(NOW - 86400)},
                                  dismissed=["skill:acme/py/alembic-helper"]))
    web = FakeWeb()
    model = FakeModel({"skill:web/qa/playwright-e2e": 9, "skill:acme/py/fastapi-pro": 8,
                       "skill:gen/eral/best-practices": 6})
    monkeypatch.setattr(ss, "_get", web)
    monkeypatch.setattr(ss, "_ask", model)

    items = await ss.run_once(now=NOW)

    # Only recent projects are topics; queries are deduped.
    assert "Old" not in model.prompts[0] and "A FastAPI backend" in model.prompts[0]
    searched = [parse_qs(urlparse(url).query)["q"][0] for url, _ in web.calls if "/api/search" in url]
    assert searched == ["fastapi alembic", "playwright e2e testing"]
    assert all(h["User-Agent"].startswith("Dolphin/") for url, h in web.calls if "/api/search" in url)
    # Skills only (skills.sh, as find-skills searches): no plugin marketplace is fetched.
    assert not any("plugins" in url for url, _ in web.calls)
    # Installed, dismissed, recently shown, under-1,000-install and duplicate candidates never reach the model.
    assert sorted(model.candidates) == sorted(["skill:acme/py/fastapi-pro", "skill:web/qa/playwright-e2e",
                                               "skill:gen/eral/best-practices"])
    assert "About playwright-e2e & more" in model.prompts[1]
    # One a day: the best with relevance of at least KEEP_RELEVANCE; unknown keys ignored.
    assert ss.KEEP == 1 and ss.KEEP_RELEVANCE == 7
    assert [item["key"] for item in items] == ["skill:web/qa/playwright-e2e"]
    skill = items[0]
    assert skill == {"key": "skill:web/qa/playwright-e2e", "kind": "skill", "name": "playwright-e2e",
                     "source": "web/qa", "url": "https://skills.sh/web/qa/playwright-e2e",
                     "install": "npx skills add web/qa@playwright-e2e", "reason": skill["reason"],
                     "project": "Web", "installs": 7000, "agent": "any"}
    assert len(skill["reason"].split()) <= 15

    view = ss.view()
    assert view["enabled"] is True and [i["key"] for i in view["items"]] == [i["key"] for i in items]
    assert set(view["items"][0]) == set(ss.ITEM_FIELDS)
    state = ss._state()
    assert all(item["key"] in state["shown"] for item in items)

    # Once a day: too soon for another run.
    assert ss.INTERVAL_SECONDS == 24 * 3600 and await ss.run_once(now=NOW + 3600) == []
    # The next day, yesterday's runner-up is today's suggestion; what was shown is not offered again.
    model2 = FakeModel({"skill:acme/py/fastapi-pro": 8, "skill:gen/eral/best-practices": 6})
    monkeypatch.setattr(ss, "_ask", model2)
    day2 = NOW + ss.INTERVAL_SECONDS + 1
    assert [i["key"] for i in await ss.run_once(now=day2)] == ["skill:acme/py/fastapi-pro"]
    assert sorted(model2.candidates) == ["skill:acme/py/fastapi-pro", "skill:gen/eral/best-practices"]
    assert [i["key"] for i in ss.view()["items"]] == ["skill:acme/py/fastapi-pro"]
    # The day after, nothing clears the bar: nothing is added and the current one stays.
    model3 = FakeModel({"skill:gen/eral/best-practices": 6})
    monkeypatch.setattr(ss, "_ask", model3)
    assert await ss.run_once(now=day2 + ss.INTERVAL_SECONDS + 1) == []
    assert model3.candidates == ["skill:gen/eral/best-practices"]
    assert [i["key"] for i in ss.view()["items"]] == ["skill:acme/py/fastapi-pro"]
    # Installing the suggested skill takes it off the list at the next run.
    _write(home / ".claude" / "skills" / "fastapi-pro" / "SKILL.md", "x")
    await ss.run_once(now=day2 + 2 * ss.INTERVAL_SECONDS + 2)
    assert ss.view()["items"] == []


@pytest.mark.asyncio
async def test_a_429_backs_off_for_a_day(home, monkeypatch):
    _brain({"projects/api": ("API", NOW - 60, "A FastAPI backend with Alembic migrations.")})
    web = FakeWeb(fail_search=429)
    model = FakeModel()
    monkeypatch.setattr(ss, "_get", web)
    monkeypatch.setattr(ss, "_ask", model)
    assert await ss.run_once(now=NOW) == []
    assert ss.backing_off(NOW + 3600) and not ss.backing_off(NOW + ss.BACKOFF_SECONDS + 1)
    assert sum("/api/search" in url for url, _ in web.calls) == 1  # stopped at the first 429
    assert len(model.prompts) == 1  # never ranked
    searches = len(web.calls)
    assert await ss.run_once(now=NOW + 3600, force=True) == []  # Check Now while backing off
    assert len(web.calls) == searches


@pytest.mark.asyncio
async def test_no_recent_work_or_no_agent_means_no_suggestions(home, monkeypatch):
    monkeypatch.setattr(ss, "_get", FakeWeb())

    async def unavailable(prompt, schema):
        raise brain_summaries.Unavailable("none")

    monkeypatch.setattr(ss, "_ask", unavailable)
    assert await ss.run_once(now=NOW) == []
    _brain({"projects/api": ("API", NOW - 60, "FastAPI.")})
    assert await ss.run_once(now=NOW + ss.INTERVAL_SECONDS + 1) == []
    assert ss.view()["items"] == []


@pytest.mark.asyncio
async def test_ranking_keeps_variety(home, monkeypatch):
    def skill(owner, name):
        return {"key": f"skill:{owner}/r/{name}", "kind": "skill", "id": f"{owner}/r/{name}", "source": f"{owner}/r",
                "skill_id": name, "name": name, "installs": 500, "agent": "any", "description": ""}

    candidates = [skill("a", "playwright-e2e"), skill("b", "playwright-e2e"), skill("c", "playwright-core"),
                  skill("d", "react-testing"), skill("e", "alembic")]
    projects = [{"project": "web", "title": "Web", "work": "Playwright"},
                {"project": "api", "title": "API", "work": "Alembic"}]

    async def model(prompt, schema):
        return {"items": [{"key": c["key"], "relevance": 8 if c["name"] == "alembic" else 9, "reason": "Fits.",
                           "project": "api" if c["name"] == "alembic" else "web"} for c in candidates]}

    monkeypatch.setattr(ss, "_ask", model)
    # One a day: the best, and one fork of a name.
    assert [item["key"] for item in await ss.rank(projects, candidates)] == ["skill:a/r/playwright-e2e"]
    monkeypatch.setattr(ss, "KEEP", 2)
    kept = await ss.rank(projects, candidates)
    # With more places, two projects in play each get one.
    assert [item["key"] for item in kept] == ["skill:a/r/playwright-e2e", "skill:e/r/alembic"]


@pytest.mark.asyncio
async def test_ask_model_takes_a_schema_and_follows_the_agent_order(monkeypatch):
    from app import agent_clis, agents, dolphin_model

    monkeypatch.setattr(agent_clis, "locate", lambda refresh=False: {"claude": "/bin/claude", "codex": "/bin/codex"})
    monkeypatch.setattr(agents, "order", lambda preferred="claude": ["codex", "claude"] if preferred == "codex" else ["claude", "codex"])
    seen = []

    async def invoke(command, prompt, cwd, timeout=100, **_):
        seen.append(command[0])
        if command[0] == "/bin/claude":
            schema = json.loads(command[command.index("--json-schema") + 1])
            return json.dumps({"structured_output": {"got": schema["title"]}})
        raise dolphin_model.EngineUnavailable("no")

    monkeypatch.setattr(dolphin_model, "invoke", invoke)
    assert await brain_summaries.ask_model("hi", {"title": "mine"}) == {"got": "mine"}
    assert await brain_summaries.ask_model("hi", {"title": "mine"}, preferred="codex") == {"got": "mine"}
    assert seen == ["/bin/claude", "/bin/codex", "/bin/claude"]


def test_the_endpoints(home, monkeypatch):
    from app.main import app

    client = TestClient(app)  # no lifespan: no database, no schedule
    monkeypatch.setattr(brain, "ready", lambda: False)
    assert client.get("/api/suggestions/skills").json() == {"enabled": False, "items": [], "generated_at": None}
    assert client.post("/api/suggestions/skills/refresh").status_code == 202
    assert client.post("/api/suggestions/skills/refresh").json() == {"started": False}

    monkeypatch.setattr(brain, "ready", lambda: True)
    item = {"key": "skill:a/b/c", "kind": "skill", "name": "c", "source": "a/b", "url": "https://skills.sh/a/b/c",
            "install": "npx skills add a/b@c", "reason": "Helps.", "project": "API", "installs": 500, "agent": "any"}
    ss._update(lambda s: s.update(items=[item, {**item, "key": "skill:a/b/d"}], generated_at="2026-10-16T00:00:00+00:00"))
    body = client.get("/api/suggestions/skills").json()
    assert body["enabled"] is True and body["generated_at"] == "2026-10-16T00:00:00+00:00"
    assert [i["key"] for i in body["items"]] == ["skill:a/b/c", "skill:a/b/d"] and body["items"][0] == item

    response = client.post("/api/suggestions/skills/dismiss", json={"key": "skill:a/b/c"})
    assert response.status_code == 204 and response.content == b""
    assert [i["key"] for i in client.get("/api/suggestions/skills").json()["items"]] == ["skill:a/b/d"]
    assert client.post("/api/suggestions/skills/dismiss", json={}).status_code == 422

    assert client.put("/api/suggestions/skills/enabled", json={"enabled": "no"}).status_code == 422
    assert client.put("/api/suggestions/skills/enabled", json={"enabled": False}).json() == {"enabled": False}
    assert client.get("/api/suggestions/skills").json()["items"] == []
    assert client.post("/api/suggestions/skills/refresh").json() == {"started": False}
    assert client.put("/api/suggestions/skills/enabled", json={"enabled": True}).json() == {"enabled": True}

    started = []

    async def fake_run(now=None, force=False):
        started.append(force)
        return []

    monkeypatch.setattr(ss, "run_once", fake_run)
    response = client.post("/api/suggestions/skills/refresh")
    assert response.status_code == 202 and response.json() == {"started": True}

    ss._update(lambda s: s.update(backoff_until=_iso(time.time() + 3600)))
    monkeypatch.setattr(ss, "_refresh_task", None)
    assert client.post("/api/suggestions/skills/refresh").json() == {"started": False}


@pytest.mark.asyncio
async def test_a_suggestion_leaves_after_item_days(home, monkeypatch):
    _installed(home)
    _brain({"projects/web": ("Web", NOW - 60, "A React app tested with Playwright.")})
    monkeypatch.setattr(ss, "_get", FakeWeb())
    monkeypatch.setattr(ss, "_ask", FakeModel({"skill:web/qa/playwright-e2e": 9}))
    assert [i["key"] for i in await ss.run_once(now=NOW)] == ["skill:web/qa/playwright-e2e"]
    monkeypatch.setattr(ss, "_ask", FakeModel({}))
    await ss.run_once(now=NOW + (ss.ITEM_DAYS + 1) * 86400)
    assert ss.view()["items"] == []
