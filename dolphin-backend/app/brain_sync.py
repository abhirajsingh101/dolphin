"""Every machine's work reaches the brain on the computer running Dolphin Desktop.

Dolphin Desktop works on this computer and on machines it reaches over SSH,
and each runs its own helper with its own brain (brain.py). This module is
both ends of bringing what those machines know home, one way, over the SSH
link Dolphin Desktop already holds:

- ``export`` (on every machine): what a cursor has not seen yet. The
  machine's projects, the agent turns that finished in them (the turn
  notifications), and the facts and pages its own brain gained (GBrain's
  ``delta``).
- ``receive`` (on the computer running Dolphin Desktop): one export goes into
  an inbox beside the brain, already turned into brain writes and labelled
  with the machine it came from. ``flush`` then writes the inbox into the brain.

GBrain's database takes one connection at a time, and an agent's
``dolphin-memory`` server holds it while that agent runs (BrainBusy). The
inbox is what makes that harmless: Dolphin Desktop advances its cursor once an
export is in the inbox, and writing resumes at the next sync.

What a machine with slug ``<m>`` adds to the brain:

    machines/<m>               the machine, and links to its projects
    projects/<m>/<project>     a project: its folder, and a dated timeline of
                               the agent turns that finished in it
    machines/<m>/brain/<slug>  the pages of the machine's own brain
    facts                      the machine's remembered facts, under their own
                               entity, with provenance "via Dolphin from <m>: ..."

Each write is safe to repeat: pages are replaced whole, GBrain skips a
duplicate fact, and a timeline line already present is not added again.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import socket
import tempfile
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from sqlalchemy import and_, or_, select

from . import brain
from .models import Notification, Project

PAGE_LIMIT = 40  # brain pages per export: each one is a get_page call
TURN_LIMIT = 200
FACT_BATCH = 20  # GBrain's remember takes at most 20 facts in one call
MAX_PAGE_CHARS = 100_000
KINDS = {"event", "preference", "commitment", "belief", "fact"}
VIA = "via Dolphin from "  # provenance prefix of an imported fact, so it never travels on

_flushing = threading.Lock()


def slug(text: str) -> str:
    value = re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")
    return value[:60].strip("-") or "unnamed"


def _yaml(value: str) -> str:
    # A JSON string is a valid YAML scalar, whatever it holds.
    return json.dumps(value, ensure_ascii=False)


def _frontmatter(fields: dict[str, str]) -> str:
    lines = "\n".join(f"{key}: {_yaml(value)}" for key, value in fields.items())
    return f"---\n{lines}\n---\n"


def _time(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    try:
        parsed = datetime.fromisoformat(str(value))
    except (TypeError, ValueError):
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


# --- export: on every machine ------------------------------------------------------

async def export(db, cursor: dict[str, Any], include_brain: bool) -> dict[str, Any]:
    """What this machine knows past ``cursor``. ``has_more`` asks for another call."""
    projects = (await db.execute(
        select(Project.id, Project.name, Project.path, Project.is_inbox)
        .where(Project.is_hidden.is_(False))
        .order_by(Project.position, Project.created_at)
    )).all()

    query = select(Notification).where(Notification.kind == "turn_end")
    after = cursor.get("turns") if isinstance(cursor.get("turns"), list) else None
    if after and len(after) == 2 and _time(after[0]):
        at = _time(after[0]).replace(tzinfo=None)
        query = query.where(or_(Notification.created_at > at, and_(Notification.created_at == at, Notification.id > str(after[1]))))
    rows = (await db.execute(query.order_by(Notification.created_at, Notification.id).limit(TURN_LIMIT))).scalars().all()
    turns_cursor = [rows[-1].created_at.isoformat(), rows[-1].id] if rows else after

    result: dict[str, Any] = {
        "hostname": socket.gethostname(),
        "projects": [{"id": p.id, "name": p.name, "path": p.path or "", "inbox": bool(p.is_inbox)} for p in projects],
        "turns": [{
            "id": row.id, "project_id": row.project_id, "provider": row.provider,
            "session": row.session_name, "summary": row.summary or "",
            "finished_at": (_time(row.finished_at) or datetime.now(timezone.utc)).isoformat(),
        } for row in rows],
        "facts": [], "pages": [],
        "brain": "off",
        "cursor": {"turns": turns_cursor, "brain": cursor.get("brain")},
        "has_more": len(rows) == TURN_LIMIT,
    }
    if include_brain and brain.ready():
        part = await asyncio.to_thread(_export_brain, cursor.get("brain"))
        if "brain_cursor" in part:
            result["cursor"]["brain"] = part.pop("brain_cursor")
        result["has_more"] = result["has_more"] or part.pop("has_more_brain", False)
        result.update(part)
    return result


def _export_brain(brain_cursor: Any) -> dict[str, Any]:
    arguments: dict[str, Any] = {"limit": PAGE_LIMIT}
    if isinstance(brain_cursor, str) and brain_cursor:
        arguments["cursor"] = brain_cursor
    else:
        arguments["since"] = "1970-01-01T00:00:00Z"
    try:
        delta = brain.call("delta", arguments)
        facts = [
            {"fact": f.get("fact", ""), "kind": f.get("kind") or "fact", "entity": f.get("entity_slug"),
             "provenance": f.get("provenance") or ""}
            for f in delta.get("facts", [])
            if f.get("fact") and not str(f.get("provenance") or "").startswith(VIA)
        ]
        pages = []
        for listed in delta.get("pages", []):
            page_slug = str(listed.get("slug") or "")
            if not page_slug or page_slug.startswith("machines/"):
                continue
            page = brain.call("get_page", {"slug": page_slug})
            if not isinstance(page, dict) or "dolphin_machine" in (page.get("frontmatter") or {}):
                continue  # written here by an earlier sync: it never travels on
            pages.append({
                "slug": page_slug, "title": page.get("title") or page_slug, "type": page.get("type") or "note",
                "body": (page.get("compiled_truth") or "")[:MAX_PAGE_CHARS],
                "timeline": (page.get("timeline") or "")[:MAX_PAGE_CHARS],
            })
    except brain.BrainBusy:
        return {"brain": "busy"}
    except brain.BrainError as error:
        return {"brain": "failed", "brain_error": str(error)[:300]}
    next_cursor = (delta.get("next_cursor") or {}).get("cursor") or brain_cursor
    return {"brain": "ready", "facts": facts, "pages": pages,
            "has_more_brain": bool(delta.get("has_more")), "brain_cursor": next_cursor}


# --- receive and flush: on the computer running Dolphin Desktop ----------------------

def _inbox() -> Path:
    return brain.base() / "sync-inbox"


def _state_path() -> Path:
    return brain.base() / "sync-state.json"


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, name = tempfile.mkstemp(prefix=".sync-", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w") as handle:
            json.dump(value, handle)
        os.replace(name, path)
    except BaseException:
        Path(name).unlink(missing_ok=True)
        raise


def _turn_line(turn: dict[str, Any], label: str) -> str:
    finished = _time(turn.get("finished_at")) or datetime.now(timezone.utc)
    agent = {"claude": "Claude", "codex": "Codex"}.get(str(turn.get("provider")), str(turn.get("provider") or "Agent"))
    summary = " ".join(str(turn.get("summary") or "").split())[:300] or "finished a turn"
    session = " ".join(str(turn.get("session") or "").split())[:80]
    return f"- **{finished.date().isoformat()}** | {label} — {finished.strftime('%H:%M')} UTC, {agent} in {session}: {summary}"


def plan(machine: dict[str, str], export_body: dict[str, Any]) -> list[dict[str, Any]]:
    """Turn one export into brain writes, labelled with the machine it came from."""
    m = slug(machine["id"])
    label = machine.get("label") or machine["id"]
    where = "this computer, where Dolphin Desktop runs" if machine.get("kind") == "local" else f"a machine reached over SSH ({machine['id']})"
    jobs: list[dict[str, Any]] = []

    project_slugs: dict[str, str] = {}
    taken: set[str] = set()
    for project in export_body.get("projects", []):
        name = slug(project["name"])
        page = f"projects/{m}/{name}" if name not in taken else f"projects/{m}/{name}-{slug(project['id'])[:6]}"
        taken.add(name)
        project_slugs[project["id"]] = page

    listing = "\n".join(
        f"- [[{project_slugs[p['id']]}]] {p['name']}" + (f" — `{p['path']}`" if p.get("path") else "")
        for p in export_body.get("projects", [])
    ) or "- none yet"
    jobs.append({"op": "page", "slug": f"machines/{m}", "content": (
        _frontmatter({"title": label, "type": "note", "dolphin_machine": m})
        + f"# {label}\n\n{label} is {where}. Hostname: `{export_body.get('hostname') or 'unknown'}`."
        + f" Dolphin keeps the projects below on it.\n\n## Projects\n\n{listing}\n"
    )})

    turns_by_project: dict[str, list[str]] = {}
    for turn in export_body.get("turns", []):
        target = project_slugs.get(turn.get("project_id") or "")
        if target:
            turns_by_project.setdefault(target, []).append(_turn_line(turn, label))
    for project in export_body.get("projects", []):
        page = project_slugs[project["id"]]
        about = f"{label}'s Inbox" if project.get("inbox") else f"the project {project['name']} on {label}"
        folder = f" Its folder is `{project['path']}`." if project.get("path") else ""
        header = (
            _frontmatter({"title": f"{project['name']} on {label}", "type": "project", "dolphin_machine": m,
                          "dolphin_project_id": project["id"], "path": project.get("path") or ""})
            + f"# {project['name']} on {label}\n\nThis is {about}, which Dolphin manages.{folder}"
            + " The timeline lists the agent turns that finished in it.\n"
        )
        jobs.append({"op": "project", "slug": page, "header": header, "lines": turns_by_project.get(page, [])})

    facts = [
        {"fact": f["fact"][:2000], "entity": f.get("entity"),
         "kind": f["kind"] if f.get("kind") in KINDS else "fact",
         "provenance": f"{VIA}{m}: {f.get('provenance') or 'no provenance'}"[:500]}
        for f in export_body.get("facts", []) if f.get("fact")
    ]
    for start in range(0, len(facts), FACT_BATCH):
        jobs.append({"op": "facts", "items": facts[start:start + FACT_BATCH]})

    for page in export_body.get("pages", []):
        content = (
            _frontmatter({"title": f"{page['title']} ({label})", "type": page.get("type") or "note",
                          "dolphin_machine": m, "dolphin_slug": page["slug"]})
            + (page.get("body") or "") + ("\n\n" + page["timeline"] if page.get("timeline") else "")
        )
        jobs.append({"op": "page", "slug": f"machines/{m}/brain/{page['slug']}", "content": content})
    return jobs


def receive(machine: dict[str, str], export_body: dict[str, Any]) -> dict[str, Any]:
    """Keep one export in the inbox, then write what the brain will take now."""
    jobs = plan(machine, export_body)
    name = f"{time.time_ns():020d}-{slug(machine['id'])}.json"
    _write_json(_inbox() / name, {"jobs": jobs})
    return flush()


def _pending() -> list[Path]:
    folder = _inbox()
    return sorted(folder.glob("*.json")) if folder.is_dir() else []


def flush() -> dict[str, Any]:
    """Write the inbox into the brain, oldest first, until it is empty or the brain is busy."""
    if not _flushing.acquire(blocking=False):
        return {"pending": len(_pending()), "busy": False, "flushing": True}
    try:
        state = _read_state()
        for path in _pending():
            try:
                jobs = json.loads(path.read_text()).get("jobs", [])
            except (OSError, ValueError):
                path.unlink(missing_ok=True)
                continue
            while jobs:
                try:
                    _apply(jobs[0], state)
                except brain.BrainBusy:
                    _write_json(path, {"jobs": jobs})
                    _write_json(_state_path(), state)
                    return {"pending": len(_pending()), "busy": True}
                except brain.BrainError as error:
                    # One bad write must not hold back the rest: it is logged and dropped.
                    state.setdefault("errors", []).append({"at": time.time(), "slug": jobs[0].get("slug"), "error": str(error)[:300]})
                    state["errors"] = state["errors"][-20:]
                jobs.pop(0)
            path.unlink(missing_ok=True)
        _write_json(_state_path(), state)
        return {"pending": 0, "busy": False}
    finally:
        _flushing.release()


def _read_state() -> dict[str, Any]:
    try:
        value = json.loads(_state_path().read_text())
    except (OSError, ValueError):
        return {"written": {}}
    return value if isinstance(value, dict) and isinstance(value.get("written"), dict) else {"written": {}}


def _digest(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def _apply(job: dict[str, Any], state: dict[str, Any]) -> None:
    written = state["written"]
    if job["op"] == "facts":
        brain.call("remember", {"items": job["items"]})
        return
    if job["op"] == "page":
        digest = _digest(job["content"])
        if written.get(job["slug"]) == digest:
            return
        brain.call("put_page", {"slug": job["slug"], "content": job["content"], "force": True})
        written[job["slug"]] = digest
        return
    # A project page: the header as exported, and the timeline it already has plus new turns.
    if written.get(job["slug"]) == _digest(job["header"]) and not job["lines"]:
        return
    try:
        timeline = str(brain.call("get_page", {"slug": job["slug"]}).get("timeline") or "")
    except brain.BrainNotFound:
        timeline = ""  # a page not written yet
    have = [line for line in timeline.splitlines() if line.startswith("- ")]
    lines = have + [line for line in job["lines"] if line not in have]
    content = job["header"] + ("\n## Timeline\n\n" + "\n".join(lines) + "\n" if lines else "")
    if lines != have or written.get(job["slug"]) != _digest(job["header"]):
        brain.call("put_page", {"slug": job["slug"], "content": content, "force": True})
    written[job["slug"]] = _digest(job["header"])
