from datetime import datetime, timezone
import hashlib

import pytest
from fastapi import HTTPException

from app.main import _select_codex_dispatch_session
from app.codex_todo_service import (
    TodoDispatchTask,
    build_codex_todo_dispatch_prompt,
    build_codex_todo_queue_prompt,
)
from app.tmux_service import TmuxSessionInfo


def _session(name: str, *, codex: bool) -> TmuxSessionInfo:
    return TmuxSessionInfo(
        name=name,
        path="/tmp/project",
        created_at=datetime.now(timezone.utc),
        windows=1,
        attached=False,
        current_command="codex" if codex else "bash",
        is_codex_running=codex,
    )


def test_codex_todo_dispatch_prompt_contains_order_and_confidence_rules():
    prompt = build_codex_todo_dispatch_prompt(
        project_name="Example",
        workspace_path="/tmp/example",
        tasks=[
            TodoDispatchTask(
                id="task-1",
                title="Fix terminal resizing",
                description="Keep xterm fitted after layout changes.",
            ),
            TodoDispatchTask(id="task-2", title="Add copy button"),
        ],
    )

    assert "\n" not in prompt
    assert "task-1" in prompt
    assert "task-2" in prompt
    assert "canonical dependency-aware order" in prompt
    assert "Preserve that order exactly" in prompt
    assert "origin and priority are metadata" in prompt
    assert "Work on exactly one todo at a time" in prompt
    assert "fully confident" in prompt
    assert "NEEDS HUMAN" in prompt
    assert "BUSY" in prompt
    assert "PUT" in prompt
    assert "/api/tasks/<task_id>" in prompt


def test_codex_todo_dispatch_prompt_json_encodes_task_text():
    prompt = build_codex_todo_dispatch_prompt(
        project_name="Example",
        workspace_path="/tmp/example",
        tasks=[TodoDispatchTask(id="task-1", title='Handle "quoted" task')],
    )

    assert '\\"quoted\\"' in prompt


def test_codex_todo_dispatch_preserves_frozen_execution_prompt_and_digest():
    exact = "Implement only this slice.\n\nKeep  double spaces and verify it."
    prompt = build_codex_todo_dispatch_prompt(
        project_name="Example",
        workspace_path="/tmp/example",
        tasks=[
            TodoDispatchTask(
                id="task-1",
                title="Short label",
                description="Supporting context",
                execution_prompt=exact,
                origin="dolphin",
            )
        ],
    )

    assert exact.replace("\n", "\\n") in prompt
    assert "Keep  double spaces" in prompt
    assert hashlib.sha256(exact.encode("utf-8")).hexdigest() in prompt
    assert '"origin":"dolphin"' in prompt
    assert "execution_prompt is its frozen exact work instruction" in prompt


def test_codex_todo_queue_prompt_start_targets_single_task():
    prompt = build_codex_todo_queue_prompt(
        project_name="Example",
        workspace_path="/tmp/example",
        task=TodoDispatchTask(id="task-1", title="Fix terminal resizing"),
        mode="start",
    )

    assert "\n" not in prompt
    assert "Start this todo now" in prompt
    assert "exactly this todo" in prompt
    assert "BUSY" in prompt
    assert "/api/tasks/task-1" in prompt


def test_codex_todo_queue_prompt_queue_preserves_order():
    prompt = build_codex_todo_queue_prompt(
        project_name="Example",
        workspace_path="/tmp/example",
        task=TodoDispatchTask(id="task-2", title="Add copy button"),
        mode="queue",
    )

    assert "Queue this todo after your current Dolphin todo" in prompt
    assert "Do not reorder it ahead of queued work" in prompt
    assert "only when it reaches the front of the queue" in prompt
    assert "task-2" in prompt


def test_quality_governed_manual_dispatch_stops_at_independent_review():
    prompt = build_codex_todo_queue_prompt(
        project_name="Example",
        workspace_path="/tmp/example",
        task=TodoDispatchTask(
            id="task-quality",
            title="Governed task",
            execution_prompt="Implement and verify the governed task.",
            origin="dolphin",
            quality_governed=True,
        ),
        mode="start",
    )

    assert '"quality_governed":true' in prompt
    assert "/quality/transition" in prompt
    assert "submit evidence" in prompt
    assert "Never review your own evidence or PUT the task Done" in prompt


def test_codex_dispatch_explicit_session_wins_when_multiple_codex_sessions_exist():
    sessions = [
        _session("dolphin-left", codex=True),
        _session("dolphin-right", codex=True),
    ]

    target = _select_codex_dispatch_session(sessions, "dolphin-right")

    assert target.name == "dolphin-right"


def test_codex_dispatch_implicit_session_rejects_multiple_codex_sessions():
    sessions = [
        _session("dolphin-left", codex=True),
        _session("dolphin-right", codex=True),
    ]

    with pytest.raises(HTTPException) as exc_info:
        _select_codex_dispatch_session(sessions, None)

    assert exc_info.value.status_code == 409
    assert "Multiple Codex sessions" in exc_info.value.detail


def test_codex_dispatch_rejects_explicit_session_without_codex():
    sessions = [_session("dolphin-shell", codex=False)]

    with pytest.raises(HTTPException) as exc_info:
        _select_codex_dispatch_session(sessions, "dolphin-shell")

    assert exc_info.value.status_code == 409
    assert "not running Codex" in exc_info.value.detail
