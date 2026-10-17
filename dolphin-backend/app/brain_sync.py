"""Every machine's work reaches the brain on the computer running Dolphin Desktop.

Dolphin Desktop works on this computer and on machines it reaches over SSH.
Only this computer has a brain (brain.py); the other machines' helpers have
none. This module is both ends of bringing their work home, one way, over the
SSH link Dolphin Desktop already holds:

- ``export`` (on every machine): what a cursor has not seen yet. The
  machine's projects, and what was asked and answered in its Claude Code and
  Codex sessions (transcript_exchanges.py). A helper older than 0.3 sends its
  turn notifications instead of exchanges.
- ``receive`` (on the computer running Dolphin Desktop): one export goes into
  an inbox beside the brain, already turned into brain writes and labelled
  with the machine it came from. ``flush`` then writes the inbox into the brain.

The inbox keeps an export safe while the brain is busy (BrainBusy): Dolphin
Desktop advances its cursor once an export is in the inbox, and writing
resumes at the next sync.

What a machine with slug ``<m>`` adds to the brain:

    machines/<m>               the machine, and links to its projects
    projects/<m>/<project>     a project (or a folder with agent work outside
                               any project): its summary (brain_summaries.py),
                               with open threads and decisions as facts
    projects/<m>/<p>/<yyyy-mm> its work log for a month: one timeline entry per
                               exchange, appended (add_timeline_entry)

Each write is safe to repeat: pages are replaced whole only when they change,
and GBrain skips a timeline entry it already has.
"""

from __future__ import annotations

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

from . import brain, brain_summaries, transcript_exchanges
from .models import AgentExchange, Notification, Project

TURN_LIMIT = 200
EXCHANGE_LIMIT = 200
LINE_PROMPT_CHARS = 200
LINE_REPLY_CHARS = 300

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

async def export(db, cursor: dict[str, Any]) -> dict[str, Any]:
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

    scanning = await transcript_exchanges.scan(db)
    query = select(AgentExchange)
    after_exchange = cursor.get("exchanges") if isinstance(cursor.get("exchanges"), list) else None
    if after_exchange and len(after_exchange) == 2 and _time(after_exchange[0]):
        at = _time(after_exchange[0]).replace(tzinfo=None)
        query = query.where(or_(AgentExchange.created_at > at,
                                and_(AgentExchange.created_at == at, AgentExchange.id > str(after_exchange[1]))))
    exchanges = (await db.execute(
        query.order_by(AgentExchange.created_at, AgentExchange.id).limit(EXCHANGE_LIMIT))).scalars().all()
    exchanges_cursor = [exchanges[-1].created_at.isoformat(), exchanges[-1].id] if exchanges else after_exchange

    result: dict[str, Any] = {
        "hostname": socket.gethostname(),
        "projects": [{"id": p.id, "name": p.name, "path": p.path or "", "inbox": bool(p.is_inbox)} for p in projects],
        "turns": [{
            "id": row.id, "project_id": row.project_id, "provider": row.provider,
            "session": row.session_name, "summary": row.summary or "",
            "finished_at": (_time(row.finished_at) or datetime.now(timezone.utc)).isoformat(),
        } for row in rows],
        "exchanges": [{
            "id": row.id, "project_id": row.project_id, "agent": row.agent, "session_id": row.session_id,
            "folder": row.folder, "prompt": row.prompt, "reply": row.reply,
            "started_at": _time(row.started_at).isoformat(), "finished_at": _time(row.finished_at).isoformat(),
        } for row in exchanges],
        "cursor": {"turns": turns_cursor, "exchanges": exchanges_cursor},
        "has_more": len(rows) == TURN_LIMIT or len(exchanges) == EXCHANGE_LIMIT or scanning,
    }
    return result


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


def _agent(name: Any) -> str:
    return {"claude": "Claude", "codex": "Codex"}.get(str(name), str(name or "Agent"))


def _short(text: Any, limit: int) -> str:
    text = " ".join(str(text or "").split())
    return text if len(text) <= limit else text[:limit - 1].rstrip() + "…"


def _turn_line(turn: dict[str, Any], label: str) -> dict[str, str]:
    finished = _time(turn.get("finished_at")) or datetime.now(timezone.utc)
    summary = _short(turn.get("summary"), 300) or "finished a turn"
    session = _short(turn.get("session"), 80)
    return {"date": finished.date().isoformat(), "source": label,
            "summary": f"{finished.strftime('%H:%M')} UTC, {_agent(turn.get('provider'))} in {session}: {summary}"}


def _exchange_line(exchange: dict[str, Any], label: str) -> dict[str, str]:
    """One timeline entry: ``- **date** | label — HH:MM UTC, Agent: prompt → reply``."""
    finished = _time(exchange.get("finished_at")) or datetime.now(timezone.utc)
    agent = _agent(exchange.get("agent"))
    prompt = _short(exchange.get("prompt"), LINE_PROMPT_CHARS)
    reply = _short(exchange.get("reply"), LINE_REPLY_CHARS) or "no reply"
    said = f"{agent}: {prompt} → {reply}" if prompt else f"{agent} (continued): {reply}"
    return {"date": finished.date().isoformat(), "source": label, "summary": f"{finished.strftime('%H:%M')} UTC, {said}"}


def plan(machine: dict[str, str], export_body: dict[str, Any]) -> list[dict[str, Any]]:
    """Turn one export into brain writes, labelled with the machine it came from.

    A ``queue`` job is not a brain write: it hands a project's new exchanges to
    the summaries (brain_summaries.py)."""
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
        + f" Dolphin keeps the projects below on it. Agent work in other folders has its own pages under"
        + f" `projects/{m}/`.\n\n## Projects\n\n{listing}\n"
    )})

    pages: dict[str, dict[str, Any]] = {}
    for project in export_body.get("projects", []):
        page = project_slugs[project["id"]]
        about = f"{label}'s Inbox" if project.get("inbox") else f"the project {project['name']} on {label}"
        folder = f" Its folder is `{project['path']}`." if project.get("path") else ""
        title = f"{project['name']} on {label}"
        pages[page] = {"title": title, "name": project["name"], "lines": [], "items": [],
                       "fields": {"title": title, "type": "project", "dolphin_machine": m,
                                  "dolphin_project_id": project["id"], "path": project.get("path") or ""},
                       "intro": f"This is {about}, which Dolphin manages.{folder}"}

    def folder_page(folder: str) -> str:
        name = slug(Path(folder).name or folder)
        page = f"projects/{m}/{name}" if name not in taken else f"projects/{m}/{name}-{_digest(folder)[:6]}"
        if page not in pages:
            title = f"{Path(folder).name or folder} on {label}"
            pages[page] = {"title": title, "name": Path(folder).name or folder, "lines": [], "items": [],
                           "fields": {"title": title, "type": "project", "dolphin_machine": m, "path": folder},
                           "intro": f"This is the folder `{folder}` on {label}. It is not a Dolphin project."}
        return page

    if "exchanges" in export_body:
        for exchange in export_body["exchanges"]:
            target = project_slugs.get(exchange.get("project_id") or "")
            if not target and exchange.get("folder"):
                target = folder_page(str(exchange["folder"]))
            if not target:
                continue
            pages[target]["lines"].append(_exchange_line(exchange, label))
            pages[target]["items"].append({
                "agent": _agent(exchange.get("agent")), "prompt": exchange.get("prompt") or "",
                "reply": exchange.get("reply") or "", "finished_at": exchange.get("finished_at"),
            })
    else:  # a helper older than 0.3 sends only its turn notifications
        for turn in export_body.get("turns", []):
            target = project_slugs.get(turn.get("project_id") or "")
            if target:
                pages[target]["lines"].append(_turn_line(turn, label))

    for page, about in pages.items():
        jobs.append({"op": "project", "slug": page, "machine": m, "title": about["title"], "name": about["name"],
                     "fields": about["fields"], "intro": about["intro"], "lines": about["lines"]})
        if about["items"]:
            jobs.append({"op": "queue", "slug": page, "title": about["title"], "items": about["items"]})

    return jobs


def receive(machine: dict[str, str], export_body: dict[str, Any]) -> dict[str, Any]:
    """Keep one export in the inbox, then write what the brain will take now."""
    jobs, new_project = [], False
    for job in plan(machine, export_body):
        if job["op"] == "queue":
            new_project |= brain_summaries.enqueue(job["slug"], job["title"], job["items"])
        else:
            jobs.append(job)
    # The overview changes with each summary; here only when a project appears.
    overview = brain_summaries.overview_job() if new_project else None
    if overview:
        jobs.append(overview)
    name = f"{time.time_ns():020d}-{slug(machine['id'])}.json"
    _write_json(_inbox() / name, {"jobs": jobs})
    return flush()


def enqueue_jobs(jobs: list[dict[str, Any]], tag: str) -> dict[str, Any]:
    """Brain writes from elsewhere on this computer (the summaries), through the same inbox."""
    _write_json(_inbox() / f"{time.time_ns():020d}-{slug(tag)}.json", {"jobs": jobs})
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


def _project_top(job: dict[str, Any], months: list[str]) -> str:
    """A project page without its timeline: frontmatter, the summary, links to the monthly logs."""
    summary = brain_summaries.summary_of(job["slug"])
    fields: dict[str, Any] = {**job["fields"], "aliases": [job.get("name") or job["title"]]}
    if summary.get("one_line"):
        fields["summary"] = summary["one_line"]
    logs = ", ".join(f"[[{job['slug']}/{month}]]" for month in sorted(months, reverse=True))
    return (_frontmatter(fields) + f"# {job['title']}\n\n{job['intro']}"
            + " Every exchange with Claude Code or Codex in it is in its monthly work log.\n"
            + brain_summaries.section(job["slug"])
            + (f"\n## Work log\n\n{logs}\n" if logs else ""))


def _log_page(job: dict[str, Any], month: str) -> str:
    when = datetime.strptime(month, "%Y-%m").strftime("%B %Y")
    title = f"{job['title']}: work in {when}"
    return (_frontmatter({"title": title, "type": "note", "dolphin_machine": job.get("machine") or ""})
            + f"# {title}\n\nWhat was asked and answered in [[{job['slug']}]] in {when}, one line per exchange.\n")


def _apply(job: dict[str, Any], state: dict[str, Any]) -> None:
    written = state["written"]
    if job["op"] == "facts":  # an inbox file from 0.2.5, when machines had brains
        brain.call("remember", {"items": job["items"]})
        return
    if job["op"] == "page":
        digest = _digest(job["content"])
        if written.get(job["slug"]) == digest:
            return
        try:
            brain.call("put_page", {"slug": job["slug"], "content": job["content"], "force": True})
        except brain.BrainBusy:
            raise
        except brain.BrainError as error:
            if not job.get("fallback") or "core_budget" not in str(error):
                raise
            brain.call("put_page", {"slug": job["slug"], "content": job["fallback"], "force": True})
        written[job["slug"]] = digest
        return
    # A project page. Its top is replaced only when it changes (a summary, a new
    # month); each exchange is one appended entry on that month's log page,
    # which GBrain skips when it is already there. A put_page with no Timeline
    # section keeps the timeline a page already has.
    page = job["slug"]
    projects = state.setdefault("projects", {})
    known = projects.get(page) or {}
    if not job.get("fields"):  # a summary refresh: the page as last synced
        if not known:
            return
        job = {**known, "slug": page, "lines": []}
    months = sorted(set(known.get("months", [])) | {line["date"][:7] for line in job["lines"]})
    projects[page] = {key: job[key] for key in ("machine", "title", "name", "fields", "intro") if key in job} | {"months": months}
    for month in months:
        log = f"{page}/{month}"
        if log not in written:
            brain.call("put_page", {"slug": log, "content": _log_page(job, month), "force": True})
            written[log] = "log"
    top = _project_top(job, months)
    if written.get(page) != _digest(top):
        brain.call("put_page", {"slug": page, "content": top, "force": True})
        written[page] = _digest(top)
    for line in job["lines"]:
        try:
            brain.call("add_timeline_entry", {"slug": f"{page}/{line['date'][:7]}", "date": line["date"],
                                              "source": line["source"], "summary": line["summary"]})
        except brain.BrainBusy:
            raise
        except brain.BrainError as error:  # one bad entry must not hold back the rest
            state.setdefault("errors", []).append({"at": time.time(), "slug": page, "error": str(error)[:300]})
