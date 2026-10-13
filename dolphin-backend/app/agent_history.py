"""Claude Code and Codex transcripts on this machine, per project: listing,
search, and lookup for "Resume in new session".

- Claude Code: ~/.claude/projects/<cwd, every non-alphanumeric as '->/<id>.jsonl,
  one JSON object per line (user/assistant messages with `cwd`, `sessionId`;
  subagent lines carry isSidechain and are left out).
- Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl; the first
  line is session_meta {id, cwd}; user_message and agent_message events hold
  the conversation (response_item repeats some of it and is de-duplicated).

A transcript belongs to a project when its folder is the project's folder,
inside it, or in one of its worktrees (tmux_service.path_in_workspace). Only
the newest 300 files per agent are considered; a line that is not JSON is
skipped. Memory is bounded: TEXT_LIMIT per message, TRANSCRIPT_TEXT_LIMIT per
transcript, CACHE_TEXT_LIMIT across the parse cache, RESULT_LIMIT results.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from .agent_usage import recent_files
from .tmux_service import path_in_workspace, worktrees_dir

FILE_LIMIT = 300
RESULT_LIMIT = 50
SNIPPETS = 3
LINE_LIMIT = 2_000_000  # a longer line is not a conversation line
TEXT_LIMIT = 4_000  # kept per message; enough to search and to snippet
TRANSCRIPT_TEXT_LIMIT = 200_000  # kept per transcript; later messages are counted, not kept
CACHE_TEXT_LIMIT = 32_000_000  # kept across every cached transcript
_EPOCH = datetime.fromtimestamp(0, timezone.utc)


@dataclass
class Transcript:
    agent: str
    id: str
    cwd: str
    path: Path
    started_at: datetime | None
    updated_at: datetime
    title: str
    texts: list[str] = field(default_factory=list)
    message_count: int = 0


def _time(raw) -> datetime | None:
    if not isinstance(raw, str):
        return None
    try:
        value = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def _mtime(path: Path) -> datetime:
    return datetime.fromtimestamp(path.stat().st_mtime, timezone.utc)


def _line(handle) -> str | None:
    """The next line, or "" for an oversized one (the rest of it is read and
    dropped in small pieces, never held), or None at the end."""
    line = handle.readline(LINE_LIMIT + 1)
    if not line:
        return None
    if len(line) > LINE_LIMIT:
        while line and not line.endswith("\n"):
            line = handle.readline(65_536)
        return ""
    return line


def _rows(path: Path):
    with path.open("r", encoding="utf-8", errors="replace") as handle:
        while (line := _line(handle)) is not None:
            if not line:
                continue
            try:
                row = json.loads(line)
            except (ValueError, RecursionError):
                continue
            if isinstance(row, dict):
                yield row


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


class _Texts:
    """A transcript's messages as kept in memory: each cut to TEXT_LIMIT, and
    kept only while the transcript's total stays within TRANSCRIPT_TEXT_LIMIT.
    Every message is counted. The first prompts are kept for the title."""

    def __init__(self) -> None:
        self.items: list[str] = []
        self.size = 0
        self.count = 0
        self.prompts: list[str] = []

    def add(self, text: str, prompt: bool) -> None:
        text = text[:TEXT_LIMIT]
        self.count += 1
        if prompt and len(self.prompts) < 20:
            self.prompts.append(text)
        if self.size + len(text) <= TRANSCRIPT_TEXT_LIMIT:
            self.items.append(text)
            self.size += len(text)


def _title(prompts: list[str]) -> str:
    for prompt in prompts:
        if not prompt.lstrip().startswith("<"):  # command and context wrappers
            return prompt.strip().splitlines()[0][:120]
    return "Untitled session"


def read_claude(path: Path) -> Transcript | None:
    cwd = None
    session_id = path.stem
    started = None
    texts = _Texts()
    for row in _rows(path):
        if row.get("isSidechain") or row.get("isMeta"):
            continue
        if cwd is None and isinstance(row.get("cwd"), str):
            cwd = row["cwd"]
        if isinstance(row.get("sessionId"), str):
            session_id = row["sessionId"]
        started = started or _time(row.get("timestamp"))
        message = row.get("message")
        if row.get("type") in ("user", "assistant") and isinstance(message, dict):
            text = _text(message.get("content")).strip()
            if text:
                texts.add(text, row["type"] == "user")
    if cwd is None:
        return None
    return Transcript("claude", session_id, cwd, path, started, _mtime(path), _title(texts.prompts),
                      texts.items, texts.count)


def _codex_meta(path: Path) -> dict | None:
    with path.open("r", encoding="utf-8", errors="replace") as handle:
        line = _line(handle)
        try:
            first = json.loads(line or "")
        except (ValueError, RecursionError):
            return None
    payload = first.get("payload") if isinstance(first, dict) and first.get("type") == "session_meta" else None
    return payload if isinstance(payload, dict) and isinstance(payload.get("cwd"), str) else None


def read_codex(path: Path) -> Transcript | None:
    meta = _codex_meta(path)
    if meta is None or not isinstance(meta.get("id"), str):
        return None
    texts = _Texts()
    seen: set[int] = set()  # hashes: the texts themselves are not held twice
    for row in _rows(path):
        payload = row.get("payload")
        if not isinstance(payload, dict):
            continue
        role, text = None, ""
        if row.get("type") == "event_msg" and payload.get("type") in ("user_message", "agent_message"):
            role = "user" if payload["type"] == "user_message" else "assistant"
            text = payload.get("message") if isinstance(payload.get("message"), str) else ""
        elif row.get("type") == "response_item" and payload.get("type") == "message" and payload.get("role") in ("user", "assistant"):
            role, text = payload["role"], _text(payload.get("content"))
        text = text.strip()[:TEXT_LIMIT]
        if not role or not text or hash(text) in seen:
            continue
        seen.add(hash(text))
        texts.add(text, role == "user")
    return Transcript("codex", meta["id"], meta["cwd"], path, _time(meta.get("timestamp")), _mtime(path),
                      _title(texts.prompts), texts.items, texts.count)


def _belongs(cwd: str, workspace: Path) -> bool:
    try:
        return path_in_workspace(Path(cwd).resolve(), workspace)
    except (OSError, RuntimeError, ValueError):  # ValueError: a NUL in the logged path
        return False


def _newest(paths) -> list[Path]:
    def key(path: Path) -> float:
        try:
            return path.stat().st_mtime
        except OSError:
            return 0.0
    return sorted(paths, key=key, reverse=True)[:FILE_LIMIT]


def _encode(path: Path) -> str:
    return re.sub(r"[^A-Za-z0-9]", "-", str(path))


def _claude_files(folders: list[Path]):
    """A project folder's own transcripts (nested ones are subagents'); a
    symlinked file is skipped, as in agent_usage."""
    for folder in folders:
        try:
            with os.scandir(folder) as entries:
                for entry in entries:
                    if entry.name.endswith(".jsonl") and entry.is_file(follow_symlinks=False):
                        yield Path(entry.path)
        except OSError:
            continue


# path -> (mtime, size, transcript, characters kept). Bounded by entries and
# by the characters held; the oldest entries go first.
_CACHE: dict[str, tuple[float, int, Transcript | None, int]] = {}
_CACHE_LIMIT = 400


def _cost(transcript: Transcript | None) -> int:
    return sum(len(text) for text in transcript.texts) if transcript else 0


def _load(path: Path, reader) -> Transcript | None:
    """A parsed transcript, re-parsed only when its size or mtime changes."""
    try:
        stat = path.stat()
        hit = _CACHE.get(str(path))
        if hit and hit[0] == stat.st_mtime and hit[1] == stat.st_size:
            return hit[2]
        transcript = reader(path)
    except (OSError, ValueError):
        return None
    cost = _cost(transcript)
    _CACHE.pop(str(path), None)
    held = sum(entry[3] for entry in _CACHE.values())
    while _CACHE and (len(_CACHE) >= _CACHE_LIMIT or held + cost > CACHE_TEXT_LIMIT):
        held -= _CACHE.pop(next(iter(_CACHE)))[3]
    if cost <= CACHE_TEXT_LIMIT:
        _CACHE[str(path)] = (stat.st_mtime, stat.st_size, transcript, cost)
    return transcript


def _claude_paths(home: Path, workspace: Path) -> list[Path]:
    base = home / ".claude" / "projects"
    if not base.is_dir():
        return []
    prefixes = (_encode(workspace), _encode(worktrees_dir(workspace)))
    folders = [folder for folder in base.iterdir()
               if folder.name.startswith(prefixes) and folder.is_dir() and not folder.is_symlink()]
    return list(_claude_files(folders))


def _codex_paths(home: Path) -> list[Path]:
    # agent_usage's walk: symlinked folders and files, and FIFOs, are never opened.
    return recent_files(home / ".codex" / "sessions", ".jsonl", _EPOCH, prefix="rollout-")


def _mine(path: Path, agent: str, workspace: Path) -> Transcript | None:
    if agent == "claude":
        transcript = _load(path, read_claude)
        return transcript if transcript and _belongs(transcript.cwd, workspace) else None
    try:
        meta = _codex_meta(path)
    except (OSError, ValueError):
        return None
    if meta is None or not _belongs(meta["cwd"], workspace):
        return None
    return _load(path, read_codex)


def transcripts(home: Path, workspace: Path) -> list[Transcript]:
    workspace = workspace.resolve()
    found = [t for path in _newest(_claude_paths(home, workspace)) if (t := _mine(path, "claude", workspace))]
    found += [t for path in _newest(_codex_paths(home)) if (t := _mine(path, "codex", workspace))]
    return sorted(found, key=lambda item: item.updated_at, reverse=True)


def _snippets(texts: list[str], needle: str) -> list[str]:
    out = []
    for text in texts:
        at = text.casefold().find(needle)
        if at < 0:
            continue
        start, end = max(0, at - 60), min(len(text), at + len(needle) + 60)
        out.append(("…" if start else "") + text[start:end].replace("\n", " ") + ("…" if end < len(text) else ""))
        if len(out) == SNIPPETS:
            break
    return out


def search(home: Path, workspace: Path, query: str = "", limit: int = RESULT_LIMIT) -> list[dict]:
    needle = query.strip().casefold()
    results = []
    for transcript in transcripts(home, workspace):
        snippets = _snippets(transcript.texts, needle) if needle else []
        if needle and not snippets:
            continue
        results.append({
            "agent": transcript.agent, "id": transcript.id, "cwd": transcript.cwd, "title": transcript.title,
            "started_at": transcript.started_at, "updated_at": transcript.updated_at,
            "message_count": transcript.message_count, "snippets": snippets,
        })
        if len(results) >= limit:
            break
    return results


def find(home: Path, workspace: Path, agent: str, session_id: str) -> Transcript | None:
    """Looked up by file name first (Claude `<id>.jsonl`, Codex `rollout-*-<id>.jsonl`),
    so only that file is parsed; every transcript is parsed only on a miss."""
    workspace = workspace.resolve()
    if agent == "claude":
        named = [path for path in _claude_paths(home, workspace) if path.stem == session_id]
    else:
        named = [path for path in _codex_paths(home) if path.stem.endswith("-" + session_id)]
    for path in named:
        transcript = _mine(path, agent, workspace)
        if transcript and transcript.id == session_id:
            return transcript
    return next((t for t in transcripts(home, workspace) if t.agent == agent and t.id == session_id), None)
