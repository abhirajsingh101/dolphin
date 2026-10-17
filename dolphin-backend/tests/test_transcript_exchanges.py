"""What was asked and answered, read from Claude Code and Codex transcripts
(app/transcript_exchanges.py). The rows mirror the shapes the agents write
today, checked against real transcripts on 2026-10-16."""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app import transcript_exchanges as tx
from app.database import Base
from app.models import AgentExchange, Project, TranscriptOffset

LATER = time.time() + 10 * tx.QUIET_SECONDS  # "now", long after the files were written


def _write(path: Path, rows: list[dict], mode: str = "w") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open(mode) as handle:
        for row in rows:
            handle.write(json.dumps(row) + "\n")
    return path


def _user(text, **extra):
    return {"type": "user", "cwd": "/work/atlas", "sessionId": "s1", "timestamp": "2026-10-16T01:00:00Z",
            "message": {"role": "user", "content": text}, **extra}


def _assistant(blocks, at="2026-10-16T01:01:00Z"):
    return {"type": "assistant", "cwd": "/work/atlas", "sessionId": "s1", "timestamp": at,
            "message": {"role": "assistant", "content": blocks}}


END = {"type": "system", "subtype": "turn_duration", "timestamp": "2026-10-16T01:02:00Z"}


def _claude_session(path: Path) -> Path:
    return _write(path, [
        {"type": "permission-mode", "permissionMode": "default"},
        _user("<command-name>/clear</command-name>", isMeta=True),
        _user("Fix the login bug"),
        _assistant([{"type": "thinking", "thinking": "hmm"}]),
        _assistant([{"type": "tool_use", "id": "t1", "name": "Bash", "input": {}}]),
        _user([{"type": "tool_result", "tool_use_id": "t1", "content": "ok"}]),
        _assistant([{"type": "text", "text": "Looking at the session code."}]),
        {**_assistant([{"type": "text", "text": "a subagent's words"}]), "isSidechain": True},
        _assistant([{"type": "text", "text": "Fixed: the cookie expired early."}], at="2026-10-16T01:05:00Z"),
        END,
        _user("<task-notification><summary>build finished</summary></task-notification>"),
        _assistant([{"type": "text", "text": "The build passed."}]),
        END,
        _user("This session is being continued from a previous conversation", isCompactSummary=True),
        _user("[Request interrupted by user]"),
        _user("My token is sk-abcdefghijklmnopqrstuvwx, deploy it"),
        _assistant([{"type": "text", "text": "Deployed with password=hunter22."}]),
        END,
    ])


def test_claude_keeps_each_prompt_and_its_final_reply(tmp_path):
    read = tx.read_claude(_claude_session(tmp_path / "s1.jsonl"), now=LATER)
    assert [(e.prompt, e.reply) for e in read.exchanges] == [
        ("Fix the login bug", "Fixed: the cookie expired early."),
        ("", "The build passed."),
        ("My token is [hidden], deploy it", "Deployed with password=[hidden]."),
    ]
    first = read.exchanges[0]
    assert first.cwd == "/work/atlas" and first.session_id == "s1" and first.finished_at.minute == 5
    assert read.offset == (tmp_path / "s1.jsonl").stat().st_size


def test_claude_waits_for_an_unfinished_turn_then_resumes_where_it_stopped(tmp_path):
    path = _write(tmp_path / "s1.jsonl", [_user("First"), _assistant([{"type": "text", "text": "One."}]), END,
                                           _user("Second"), _assistant([{"type": "text", "text": "Working"}])])
    read = tx.read_claude(path, now=time.time())
    assert [e.prompt for e in read.exchanges] == ["First"]
    assert read.offset < path.stat().st_size  # the open turn is read again next time

    _write(path, [_assistant([{"type": "text", "text": "Two."}]), END], mode="a")
    again = tx.read_claude(path, read.offset, read.session_id, read.cwd, now=time.time())
    assert [(e.prompt, e.reply) for e in again.exchanges] == [("Second", "Two.")]
    assert again.exchanges[0].offset == read.offset  # the same key as if read in one go


def test_claude_turn_with_no_end_row_is_kept_once_the_file_is_quiet(tmp_path):
    path = _write(tmp_path / "s1.jsonl", [_user("Old agent"), _assistant([{"type": "text", "text": "Reply."}])])
    assert tx.read_claude(path, now=time.time()).exchanges == []
    assert [e.reply for e in tx.read_claude(path, now=LATER).exchanges] == ["Reply."]


def _codex(kind, payload, at="2026-10-16T02:00:00Z"):
    return {"type": kind, "timestamp": at, "payload": payload}


def _message(role, text):
    return _codex("response_item", {"type": "message", "role": role, "content": [{"type": "input_text", "text": text}]})


def test_codex_turns_run_from_task_started_to_task_complete(tmp_path):
    path = _write(tmp_path / "rollout-2026-10-16T02-00-00-abc.jsonl", [
        _codex("session_meta", {"id": "abc", "cwd": "/work/robot"}),
        _codex("event_msg", {"type": "task_started", "turn_id": "1"}),
        _message("user", "# AGENTS.md instructions for /work/robot\n..."),
        _message("user", "<environment_context>\n<cwd>/work/robot</cwd>"),
        _message("user", "What is the status?"),
        _message("user", "What is the status?"),
        _codex("event_msg", {"type": "turn_aborted", "turn_id": "1", "reason": "interrupted"}),
        _codex("event_msg", {"type": "task_started", "turn_id": "2"}),
        _message("user", "What is the status? Again"),
        _codex("response_item", {"type": "function_call", "name": "shell", "arguments": "{}"}),
        _codex("event_msg", {"type": "task_complete", "turn_id": "2", "last_agent_message": "Training runs."}, at="2026-10-16T02:09:00Z"),
        _codex("event_msg", {"type": "task_started", "turn_id": "3"}),
        _message("user", "go ahead"),
    ])
    read = tx.read_codex(path, now=time.time())
    assert [(e.prompt, e.reply) for e in read.exchanges] == [
        ("What is the status?", "(stopped before finishing)"),
        ("What is the status? Again", "Training runs."),
    ]
    assert read.session_id == "abc" and read.cwd == "/work/robot" and read.exchanges[1].finished_at.minute == 9
    assert read.offset < path.stat().st_size  # "go ahead" has no answer yet


def test_an_older_codex_with_user_message_events(tmp_path):
    path = _write(tmp_path / "rollout-old-def.jsonl", [
        _codex("session_meta", {"id": "def", "cwd": "/work/old"}),
        _codex("event_msg", {"type": "user_message", "message": "Rename the module"}),
        _codex("event_msg", {"type": "agent_message", "message": "Renamed."}),
    ])
    read = tx.read_codex(path, now=LATER)
    assert [(e.prompt, e.reply) for e in read.exchanges] == [("Rename the module", "Renamed.")]


@pytest_asyncio.fixture
async def factory():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    yield async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    await engine.dispose()


@pytest.mark.asyncio
async def test_a_scan_stores_each_exchange_once_with_its_project(tmp_path, monkeypatch, factory):
    claude, codex = tmp_path / "claude", tmp_path / "codex"
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(claude))
    monkeypatch.setenv("CODEX_HOME", str(codex))
    work = tmp_path / "work"
    (work / "atlas" / "src").mkdir(parents=True)
    session = _claude_session(claude / "projects" / "-work-atlas" / "s1.jsonl")
    lines = session.read_text().replace("/work/atlas", str(work / "atlas" / "src"))
    session.write_text(lines)
    old = time.time() - 2 * tx.QUIET_SECONDS
    os.utime(session, (old, old))
    _write(claude / "projects" / "-work-atlas" / "s1" / "subagents" / "agent-1.jsonl", [_user("nested")])
    rollout = _write(codex / "sessions" / "2026" / "10" / "16" / "rollout-x-abc.jsonl", [
        _codex("session_meta", {"id": "abc", "cwd": str(tmp_path / "elsewhere")}),
        _codex("event_msg", {"type": "task_started"}), _message("user", "Hi"),
        _codex("event_msg", {"type": "task_complete", "last_agent_message": "Hello."}),
    ])
    async with factory() as db:
        db.add(Project(id="p1", name="Atlas", path=str(work / "atlas"), position=0))
        await db.commit()
        assert await tx.scan(db, force=True) is False
        await tx.scan(db, force=True)  # nothing new: nothing stored twice
        rows = (await db.execute(select(AgentExchange).order_by(AgentExchange.started_at))).scalars().all()
        offsets = (await db.execute(select(TranscriptOffset))).scalars().all()
    by_prompt = {row.prompt: row for row in rows}
    assert len(rows) == 4 and "nested" not in by_prompt
    assert by_prompt["Fix the login bug"].project_id == "p1"
    assert by_prompt["Hi"].project_id is None and by_prompt["Hi"].folder == str((tmp_path / "elsewhere").resolve())
    assert {Path(o.path).name for o in offsets} == {"s1.jsonl", rollout.name}
