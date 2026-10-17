"""What was asked and answered in every Claude Code and Codex session on this machine.

The brain learns each project's work from its exchanges: one user prompt and
the agent's final reply to it. Nothing else in a transcript is kept: no tool
calls, no code changes, no commands. The transcripts stay where the agents
keep them; this reads each one from where it last stopped and stores the
finished exchanges in ``agent_exchanges`` for ``brain_sync.export``.

- Claude Code (``~/.claude/projects/<folder>/<id>.jsonl``): a turn ends at its
  ``turn_duration`` system row. A human prompt (a user row with text that is
  not a ``<...>`` wrapper, a tool result, a compact summary or a sidechain)
  starts one; a turn something else started (a background task reporting
  back) is kept as a continuation with no prompt. The reply is the turn's last
  assistant text.
- Codex (``~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl``): a turn runs from
  ``task_started`` to ``task_complete`` (or ``turn_aborted``). The prompt is the
  turn's first user message that is not AGENTS.md or environment context; the
  reply is ``task_complete``'s ``last_agent_message``.
- A turn with no end row is kept once its file has been quiet for QUIET_SECONDS.

Files are byte-offset resumable: the offset kept is the start of the first
turn not yet finished, so a rescan never stores a turn twice, and the key of
an exchange (agent, session, offset of its first line) is stable.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

from sqlalchemy import delete, select
from sqlalchemy.dialects.sqlite import insert

from .agent_usage import recent_files
from .models import AgentExchange, Project, TranscriptOffset
from .tmux_service import path_in_workspace

TEXT_LIMIT = 4_000       # kept per prompt and per reply
LINE_LIMIT = 2_000_000   # a longer line is not a conversation line
QUIET_SECONDS = 300      # a turn with no end row is finished once its file is this quiet
BACKFILL = timedelta(days=14)
RETAIN = timedelta(days=30)
SCAN_BUDGET_SECONDS = 8.0
MIN_SCAN_INTERVAL = 15.0

# Things that look like credentials, masked before an exchange is stored.
_SECRETS = re.compile(
    r"(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}"
    r"|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|4/0A[0-9A-Za-z_-]{20,}|ya29\.[0-9A-Za-z_-]{20,}"
    r"|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}"
    r"|(?i:bearer)\s+[A-Za-z0-9._~+/=-]{20,}"
    r"|-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$))"
)
_ASSIGNED = re.compile(r"(?i)\b(password|passwd|secret|token|api[_-]?key)(\s*[:=]\s*)(\S{6,}?)(?=[.,;)]?(?:\s|$))")


def mask(text: str) -> str:
    text = _SECRETS.sub("[hidden]", text)
    return _ASSIGNED.sub(lambda m: m.group(1) + m.group(2) + "[hidden]", text)


def _clip(text: str) -> str:
    return mask(text.strip())[:TEXT_LIMIT]


@dataclass
class Exchange:
    agent: str
    session_id: str
    cwd: str
    offset: int
    prompt: str
    reply: str
    started_at: datetime | None
    finished_at: datetime | None

    @property
    def key(self) -> str:
        return f"{self.agent}:{self.session_id}:{self.offset}"


@dataclass
class Read:
    exchanges: list[Exchange]
    offset: int        # where the next read starts
    session_id: str
    cwd: str


def _time(raw) -> datetime | None:
    if not isinstance(raw, str):
        return None
    try:
        value = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def _rows(path: Path, offset: int):
    """(offset of the line, row) from ``offset`` on. A partial last line is left for later."""
    with path.open("rb") as handle:
        handle.seek(offset)
        position = offset
        while True:
            line = handle.readline(LINE_LIMIT + 1)
            if not line:
                return
            if not line.endswith(b"\n"):
                if len(line) <= LINE_LIMIT:
                    return  # still being written
                while line and not line.endswith(b"\n"):
                    line = handle.readline(65_536)
                position = handle.tell()
                continue
            start, position = position, handle.tell()
            try:
                row = json.loads(line)
            except (ValueError, RecursionError):
                continue
            if isinstance(row, dict):
                yield start, position, row


def _text(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(
            block["text"] for block in content
            if isinstance(block, dict) and block.get("type") in ("text", "input_text", "output_text")
            and isinstance(block.get("text"), str)
        )
    return ""


def _has_tool_result(content) -> bool:
    return isinstance(content, list) and any(isinstance(b, dict) and b.get("type") == "tool_result" for b in content)


class _Turn:
    def __init__(self, offset: int, prompt: str, at: datetime | None):
        self.offset, self.prompt, self.started_at = offset, prompt, at
        self.reply, self.finished_at = "", at


def _finish(turns: list[Exchange], turn: _Turn | None, agent: str, session: str, cwd: str) -> None:
    if turn is not None and (turn.prompt or turn.reply):
        turns.append(Exchange(agent, session, cwd, turn.offset, _clip(turn.prompt), _clip(turn.reply),
                              turn.started_at, turn.finished_at))


def _quiet(path: Path, now: float) -> bool:
    try:
        return now - path.stat().st_mtime >= QUIET_SECONDS
    except OSError:
        return False


def read_claude(path: Path, offset: int = 0, session: str = "", cwd: str = "", now: float | None = None) -> Read:
    now = time.time() if now is None else now
    session = session or path.stem
    found: list[Exchange] = []
    turn: _Turn | None = None
    resume = offset
    end = offset
    for start, end, row in _rows(path, offset):
        if row.get("isSidechain"):
            continue
        if isinstance(row.get("cwd"), str) and row["cwd"]:
            cwd = row["cwd"]
        if isinstance(row.get("sessionId"), str) and row["sessionId"]:
            session = row["sessionId"]
        kind = row.get("type")
        at = _time(row.get("timestamp"))
        message = row.get("message") if isinstance(row.get("message"), dict) else {}
        if kind == "user" and not row.get("isMeta") and not row.get("isCompactSummary"):
            content = message.get("content")
            if _has_tool_result(content):
                continue
            text = _text(content).strip()
            if not text or text.startswith("[Request interrupted"):
                continue
            human = not text.startswith("<")
            if human:
                _finish(found, turn, "claude", session, cwd)
                turn = _Turn(start, text, at)
            elif turn is None:
                turn = _Turn(start, "", at)
            resume = turn.offset
        elif kind == "assistant" and turn is not None:
            text = _text(message.get("content")).strip()
            if text:
                turn.reply, turn.finished_at = text, at or turn.finished_at
        elif kind == "system" and row.get("subtype") == "turn_duration" and turn is not None:
            _finish(found, turn, "claude", session, cwd)
            turn, resume = None, end
        if turn is None:
            resume = end
    if turn is not None and _quiet(path, now):
        _finish(found, turn, "claude", session, cwd)
        resume = end
    return Read(found, resume, session, cwd)


_CODEX_CONTEXT = ("<", "# AGENTS.md", "<environment_context>", "<user_instructions>")


def read_codex(path: Path, offset: int = 0, session: str = "", cwd: str = "", now: float | None = None) -> Read:
    now = time.time() if now is None else now
    found: list[Exchange] = []
    turn: _Turn | None = None
    resume = offset
    end = offset
    for start, end, row in _rows(path, offset):
        kind = row.get("type")
        payload = row.get("payload") if isinstance(row.get("payload"), dict) else {}
        at = _time(row.get("timestamp"))
        event = payload.get("type")
        if kind == "session_meta":
            session = payload.get("id") if isinstance(payload.get("id"), str) else session
            cwd = payload.get("cwd") if isinstance(payload.get("cwd"), str) else cwd
        elif kind == "turn_context" and isinstance(payload.get("cwd"), str):
            cwd = payload["cwd"]
        elif kind == "event_msg" and event == "task_started":
            _finish(found, turn, "codex", session, cwd)
            turn = _Turn(start, "", at)
        elif kind == "event_msg" and event in ("task_complete", "turn_aborted"):
            if turn is not None:
                if event == "task_complete" and isinstance(payload.get("last_agent_message"), str):
                    turn.reply = payload["last_agent_message"] or turn.reply
                elif event == "turn_aborted" and not turn.reply:
                    turn.reply = "(stopped before finishing)"
                turn.finished_at = at or turn.finished_at
                _finish(found, turn, "codex", session, cwd)
            turn, resume = None, end
            continue
        else:
            prompt = ""
            if kind == "event_msg" and event == "user_message" and isinstance(payload.get("message"), str):
                prompt = payload["message"]
            elif kind == "response_item" and event == "message" and payload.get("role") == "user":
                prompt = _text(payload.get("content"))
            elif kind == "event_msg" and event == "agent_message" and turn is not None:
                if isinstance(payload.get("message"), str) and payload["message"].strip():
                    turn.reply, turn.finished_at = payload["message"], at or turn.finished_at
            prompt = prompt.strip()
            if prompt and not prompt.startswith(_CODEX_CONTEXT):
                if turn is None:
                    turn = _Turn(start, prompt, at)  # an older Codex: no task_started
                elif not turn.prompt:
                    turn.prompt, turn.started_at = prompt, at or turn.started_at
        if turn is None:
            resume = end
        else:
            resume = turn.offset
    if turn is not None and _quiet(path, now):
        _finish(found, turn, "codex", session, cwd)
        resume = end
    return Read(found, resume, session, cwd)


# --- scanning this machine ---------------------------------------------------------

def _claude_home() -> Path:
    return Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude")


def _codex_home() -> Path:
    return Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex")


def candidates(since: datetime) -> list[tuple[str, Path]]:
    """Transcripts changed since ``since``: a Claude project folder's own files
    (nested ones are subagents'), and every Codex rollout."""
    found: list[tuple[str, Path]] = []
    base = _claude_home() / "projects"
    if base.is_dir():
        for folder in base.iterdir():
            if not folder.is_dir() or folder.is_symlink():
                continue
            try:
                with os.scandir(folder) as entries:
                    for entry in entries:
                        if (entry.name.endswith(".jsonl") and entry.is_file(follow_symlinks=False)
                                and datetime.fromtimestamp(entry.stat().st_mtime, timezone.utc) >= since):
                            found.append(("claude", Path(entry.path)))
            except OSError:
                continue
    found += [("codex", path) for path in recent_files(_codex_home() / "sessions", ".jsonl", since, prefix="rollout-")]
    return found


def git_root(cwd: str) -> str:
    """The repository a folder belongs to, or the folder itself."""
    try:
        path = Path(cwd).resolve()
    except (OSError, RuntimeError, ValueError):
        return cwd
    for folder in (path, *path.parents):
        if folder == Path.home() or len(folder.parts) <= 2:  # never a home or a top-level folder
            break
        if (folder / ".git").exists():
            return str(folder)
    return str(path)


def project_for(cwd: str, projects: list[tuple[str, Path]]) -> str | None:
    """The deepest Dolphin project whose folder (or one of its worktrees) holds ``cwd``."""
    try:
        resolved = Path(cwd).resolve()
    except (OSError, RuntimeError, ValueError):
        return None
    best: tuple[str, Path] | None = None
    for project_id, root in projects:
        if path_in_workspace(resolved, root) and (best is None or len(root.parts) > len(best[1].parts)):
            best = (project_id, root)
    return best[0] if best else None


def _read_files(work: list[tuple[str, Path, TranscriptOffset | None]], budget: float, now: float):
    """Read changed files until the budget runs out. Runs in a thread."""
    started = time.monotonic()
    results = []
    for agent, path, known in work:
        if time.monotonic() - started > budget:
            return results, True
        reader = read_claude if agent == "claude" else read_codex
        try:
            stat = path.stat()
            read = reader(path, known.offset if known else 0, known.session_id if known else "",
                          known.cwd if known else "", now)
        except OSError:
            continue
        results.append((agent, path, stat, read))
    return results, False


def _due(known: TranscriptOffset | None, stat: os.stat_result, now: float) -> bool:
    if known is None:
        return True
    if stat.st_size != known.size or stat.st_mtime != known.mtime:
        return True
    # Unchanged, but a turn is waiting for the file to go quiet.
    return known.offset < stat.st_size and now - stat.st_mtime >= QUIET_SECONDS


_scan_lock = asyncio.Lock()
_last_scan = 0.0
_more_waiting = False


async def scan(db, *, force: bool = False) -> bool:
    """Store every exchange finished since the last scan. True while files are
    still waiting (the time budget ran out), so the caller knows there is more."""
    global _last_scan, _more_waiting
    async with _scan_lock:
        now = time.time()
        if not force and not _more_waiting and now - _last_scan < MIN_SCAN_INTERVAL:
            return False
        _last_scan = now
        known = {row.path: row for row in (await db.execute(select(TranscriptOffset))).scalars().all()}
        work = []
        found = await asyncio.to_thread(candidates, datetime.now(timezone.utc) - BACKFILL)
        listed = {str(path) for _agent, path in found}
        gone = [path for path in known if path not in listed and not os.path.exists(path)]
        if gone:
            await db.execute(delete(TranscriptOffset).where(TranscriptOffset.path.in_(gone)))
        for agent, path in found:
            try:
                stat = path.stat()
            except OSError:
                continue
            if _due(known.get(str(path)), stat, now):
                work.append((agent, path, known.get(str(path))))
        results, more = await asyncio.to_thread(_read_files, work, SCAN_BUDGET_SECONDS, now)

        projects = []
        for project_id, folder in (await db.execute(
                select(Project.id, Project.path).where(Project.path.is_not(None), Project.is_hidden.is_(False)))).all():
            try:
                projects.append((project_id, Path(folder).expanduser().resolve()))
            except (OSError, RuntimeError, ValueError):
                continue
        stored_at = datetime.now(timezone.utc)
        for agent, path, stat, read in results:
            for exchange in read.exchanges:
                await db.execute(insert(AgentExchange).values(
                    key=exchange.key, agent=agent, session_id=exchange.session_id, cwd=exchange.cwd,
                    folder=git_root(exchange.cwd) if exchange.cwd else "",
                    project_id=project_for(exchange.cwd, projects) if exchange.cwd else None,
                    prompt=exchange.prompt, reply=exchange.reply,
                    started_at=exchange.started_at or exchange.finished_at or stored_at,
                    finished_at=exchange.finished_at or stored_at, created_at=stored_at,
                ).on_conflict_do_nothing(index_elements=["key"]))
            await db.execute(insert(TranscriptOffset).values(
                path=str(path), agent=agent, offset=read.offset, size=stat.st_size, mtime=stat.st_mtime,
                session_id=read.session_id, cwd=read.cwd,
            ).on_conflict_do_update(index_elements=["path"], set_={
                "offset": read.offset, "size": stat.st_size, "mtime": stat.st_mtime,
                "session_id": read.session_id, "cwd": read.cwd,
            }))
        await db.execute(delete(AgentExchange).where(AgentExchange.created_at < stored_at - RETAIN))
        await db.commit()
        _more_waiting = more
        return more
