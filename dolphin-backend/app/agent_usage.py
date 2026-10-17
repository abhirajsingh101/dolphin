"""Claude Code and Codex usage on this machine, read from their own logs the
way ccusage reads them. Token counts, not cost.

- Claude Code writes one JSON line per message under
  ~/.claude/projects/**/*.jsonl; assistant lines carry message.usage. A
  streamed or resumed message repeats, so each (message.id, requestId)
  counts once.
- Codex writes ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl; each token_count
  event carries last_token_usage (that turn's tokens) and, when the account
  reports them, rate_limits for its 5-hour and weekly windows.

Windows:
- five_hour: the current 5-hour block. A block starts at the hour of the
  first message after the previous block ended (or after 5 idle hours) and
  lasts 5 hours; none when the last block has ended. burn_per_minute is the
  block's tokens over the minutes between its first and last message.
- seven_day: tokens in the last 7 days, rolling.

Only files changed in the last 7 days are read, and each only again once its
size or mtime changes, so a poll costs little after the first. A line that is
not JSON (one being written) is skipped.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

BLOCK = timedelta(hours=5)
WEEK = timedelta(days=7)


@dataclass(frozen=True)
class Entry:
    at: datetime
    tokens: int
    key: tuple | None = None


_FILE_CACHE: dict[str, tuple[float, int, list[Entry], dict | None]] = {}


def _time(raw) -> datetime | None:
    if not isinstance(raw, str):
        return None
    try:
        value = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    return value.astimezone(timezone.utc) if value.tzinfo else value.replace(tzinfo=timezone.utc)


def _int(value) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else 0


def _rows(path: Path, needle: str):
    with path.open("r", encoding="utf-8", errors="replace") as handle:
        for line in handle:
            if needle not in line:
                continue
            try:
                row = json.loads(line)
            except (ValueError, RecursionError):
                continue
            if isinstance(row, dict):
                yield row


def claude_entries(path: Path) -> list[Entry]:
    entries = []
    for row in _rows(path, '"usage"'):
        message = row.get("message")
        usage = message.get("usage") if isinstance(message, dict) else None
        at = _time(row.get("timestamp"))
        if not isinstance(usage, dict) or at is None:
            continue
        tokens = sum(_int(usage.get(name)) for name in (
            "input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"))
        ids = tuple(value if isinstance(value, str) else None for value in (message.get("id"), row.get("requestId")))
        entries.append(Entry(at, tokens, ids if ids != (None, None) else None))
    return entries


def codex_file(path: Path) -> tuple[list[Entry], dict | None]:
    entries: list[Entry] = []
    limits = None
    for row in _rows(path, '"token_count"'):
        payload = row.get("payload")
        at = _time(row.get("timestamp"))
        if not isinstance(payload, dict) or payload.get("type") != "token_count" or at is None:
            continue
        info = payload.get("info") if isinstance(payload.get("info"), dict) else {}
        last = info.get("last_token_usage")
        if isinstance(last, dict):
            tokens = _int(last.get("total_tokens")) or _int(last.get("input_tokens")) + _int(last.get("output_tokens"))
            if tokens:
                entries.append(Entry(at, tokens))
        if isinstance(payload.get("rate_limits"), dict):
            limits = {"at": at, "limits": payload["rate_limits"]}
    return entries, limits


def agent_home(home: Path, agent: str) -> Path:
    """Where an agent keeps its data: ~/.claude and ~/.codex, or the folder
    CLAUDE_CONFIG_DIR / CODEX_HOME names for this user."""
    variable = "CLAUDE_CONFIG_DIR" if agent == "claude" else "CODEX_HOME"
    if os.environ.get(variable) and home == Path.home():
        return Path(os.environ[variable]).expanduser()
    return home / (".claude" if agent == "claude" else ".codex")


def recent_files(base: Path, suffix: str, since: datetime, prefix: str = "") -> list[Path]:
    """Regular files under base changed since `since`; symlinks (file or directory) and
    non-regular files (FIFOs) are never followed or opened."""
    if not base.is_dir():
        return []
    found = []
    for folder, _dirs, names in os.walk(base, followlinks=False):
        for name in names:
            if not name.endswith(suffix) or not name.startswith(prefix):
                continue
            path = Path(folder) / name
            try:
                if path.is_symlink() or not path.is_file():
                    continue
                if datetime.fromtimestamp(path.stat().st_mtime, timezone.utc) >= since:
                    found.append(path)
            except OSError:
                continue
    return found


def _cached(path: Path, reader) -> tuple[list[Entry], dict | None]:
    try:
        stat = path.stat()
    except OSError:
        return [], None
    hit = _FILE_CACHE.get(str(path))
    if hit and hit[0] == stat.st_mtime and hit[1] == stat.st_size:
        return hit[2], hit[3]
    try:
        entries, limits = reader(path)
    except OSError:
        return [], None
    cutoff = datetime.now(timezone.utc) - WEEK
    entries = [entry for entry in entries if entry.at >= cutoff]
    _FILE_CACHE[str(path)] = (stat.st_mtime, stat.st_size, entries, limits)
    return entries, limits


def five_hour_block(entries: list[Entry], now: datetime) -> dict | None:
    start = first = last = None
    total = 0
    for entry in sorted(entries, key=lambda item: item.at):
        if start is None or entry.at >= start + BLOCK or entry.at - last >= BLOCK:
            start, first, total = entry.at.replace(minute=0, second=0, microsecond=0), entry.at, 0
        total += entry.tokens
        last = entry.at
    if start is None or now >= start + BLOCK:
        return None
    minutes = max(1.0, (last - first).total_seconds() / 60)
    return {"tokens": total, "started_at": start, "ends_at": start + BLOCK, "burn_per_minute": round(total / minutes)}


def _limits(found: dict | None, now: datetime | None = None) -> list[dict]:
    if not found:
        return []
    out = []
    now = datetime.now(timezone.utc) if now is None else now
    for value in found["limits"].values():
        if not isinstance(value, dict) or not isinstance(value.get("used_percent"), (int, float)):
            continue
        resets = None
        if isinstance(value.get("resets_at"), (int, float)):
            resets = datetime.fromtimestamp(value["resets_at"], timezone.utc)
        elif isinstance(value.get("resets_in_seconds"), (int, float)):
            resets = found["at"] + timedelta(seconds=value["resets_in_seconds"])
        if resets is not None and resets <= now:
            continue
        out.append({"window_minutes": int(value.get("window_minutes") or 0),
                    "used_percent": float(value["used_percent"]), "resets_at": resets})
    return sorted(out, key=lambda item: item["window_minutes"])


def _summary(agent: str, found: bool, entries: list[Entry], limits: list[dict], now: datetime) -> dict:
    week = [entry for entry in entries if now - WEEK <= entry.at <= now]
    return {"agent": agent, "found": found, "five_hour": five_hour_block(week, now),
            "seven_day": {"tokens": sum(entry.tokens for entry in week)}, "limits": limits}


def collect(home: Path, now: datetime | None = None) -> dict:
    now = now or datetime.now(timezone.utc)
    since = now - WEEK
    scanned: set[str] = set()
    claude_base = agent_home(home, "claude") / "projects"
    seen: set[tuple] = set()
    claude: list[Entry] = []
    for path in recent_files(claude_base, ".jsonl", since):
        scanned.add(str(path))
        entries, _ = _cached(path, lambda p: (claude_entries(p), None))
        for entry in entries:
            if entry.key is not None:
                if entry.key in seen:
                    continue
                seen.add(entry.key)
            claude.append(entry)
    codex_base = agent_home(home, "codex") / "sessions"
    codex: list[Entry] = []
    latest = None
    for path in recent_files(codex_base, ".jsonl", since, "rollout-"):
        scanned.add(str(path))
        entries, limits = _cached(path, codex_file)
        codex.extend(entries)
        if limits and (latest is None or limits["at"] > latest["at"]):
            latest = limits
    for stale in [key for key in _FILE_CACHE if key not in scanned]:
        del _FILE_CACHE[stale]
    return {"collected_at": now, "agents": [
        _summary("claude", claude_base.is_dir(), claude, [], now),
        _summary("codex", codex_base.is_dir(), codex, _limits(latest, now), now),
    ]}
