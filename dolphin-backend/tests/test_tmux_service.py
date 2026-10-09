import asyncio
import hashlib
import shlex
from datetime import datetime, timezone
from pathlib import Path

import pytest

import app.tmux_service as tmux_service


def test_make_session_name_puts_requested_title_before_dolphin_suffix():
    assert tmux_service.make_session_name("Dolphin Tasks", "review") == (
        "review-dolphin"
    )
    assert tmux_service.make_session_name(
        "Dolphin Tasks",
        "review-dolphin",
    ) == "review-dolphin"
    assert tmux_service.make_session_name(
        "Dolphin Tasks",
        "dolphin-review",
    ) == "dolphin-review"

    longest_browser_name = "x" * 72
    result = tmux_service.make_session_name(
        "Dolphin Tasks",
        longest_browser_name,
    )
    assert result == f"{longest_browser_name}-dolphin"
    assert len(result) == 80


def test_make_session_name_puts_project_before_unique_dolphin_suffix(
    monkeypatch,
):
    class FakeUUID:
        hex = "307994abcdef"

    monkeypatch.setattr(tmux_service.uuid, "uuid4", lambda: FakeUUID())

    assert tmux_service.make_session_name("Dolphin Tasks") == (
        "dolphin-tasks-307994-dolphin"
    )


def test_make_session_name_preserves_invalid_character_rejection():
    with pytest.raises(
        tmux_service.TmuxServiceError,
        match="letters, numbers, dots, dashes, and underscores",
    ):
        tmux_service.make_session_name("Dolphin Tasks", "review:unsafe")


def test_create_session_detects_collision_after_suffix_naming(
    tmp_path,
    monkeypatch,
):
    workspace = tmp_path / "project"
    workspace.mkdir()
    existing = tmux_service.TmuxSessionInfo(
        name="review-dolphin",
        path=str(workspace.resolve()),
        created_at=datetime.now(timezone.utc),
        windows=1,
        attached=False,
        current_command="bash",
        is_codex_running=False,
    )

    async def fake_list_all_sessions():
        return [existing]

    async def reject_spawn(*_args):
        raise AssertionError("Collision handling must not spawn tmux.")

    monkeypatch.setattr(
        tmux_service,
        "list_all_sessions",
        fake_list_all_sessions,
    )
    monkeypatch.setattr(
        tmux_service,
        "_spawn_tmux_detached",
        reject_spawn,
    )

    with pytest.raises(
        tmux_service.TmuxServiceError,
        match="already exists",
    ):
        asyncio.run(
            tmux_service.create_session(
                workspace,
                "Dolphin Tasks",
                "review",
            )
        )


def test_rename_session_uses_exact_target_and_returns_refreshed_session(
    tmp_path,
    monkeypatch,
):
    workspace = tmp_path / "project"
    workspace.mkdir()
    old_session = tmux_service.TmuxSessionInfo(
        name="review-dolphin",
        path=str(workspace.resolve()),
        created_at=datetime.now(timezone.utc),
        windows=1,
        attached=True,
        current_command="bash",
        is_codex_running=False,
    )
    renamed_session = tmux_service.TmuxSessionInfo(
        name="release-dolphin",
        path=str(workspace.resolve()),
        created_at=old_session.created_at,
        windows=1,
        attached=True,
        current_command="bash",
        is_codex_running=False,
    )
    required_names: list[str] = []
    tmux_calls: list[tuple[str, ...]] = []

    async def fake_require_workspace_session(_workspace_path, session_name):
        required_names.append(session_name)
        return old_session if session_name == old_session.name else renamed_session

    async def fake_list_all_sessions():
        return [old_session]

    async def fake_run_tmux(*args, check=True):
        assert check is False
        tmux_calls.append(args)
        return 0, "", ""

    monkeypatch.setattr(
        tmux_service,
        "require_workspace_session",
        fake_require_workspace_session,
    )
    monkeypatch.setattr(
        tmux_service,
        "list_all_sessions",
        fake_list_all_sessions,
    )
    monkeypatch.setattr(tmux_service, "_run_tmux", fake_run_tmux)

    result = asyncio.run(
        tmux_service.rename_session(
            workspace,
            "Dolphin Tasks",
            old_session.name,
            "release",
        )
    )

    assert result == renamed_session
    assert required_names == ["review-dolphin", "release-dolphin"]
    assert tmux_calls == [
        ("rename-session", "-t", "=review-dolphin", "release-dolphin")
    ]


def test_rename_session_rejects_duplicate_before_tmux_mutation(
    tmp_path,
    monkeypatch,
):
    workspace = tmp_path / "project"
    workspace.mkdir()
    old_session = tmux_service.TmuxSessionInfo(
        name="review-dolphin",
        path=str(workspace.resolve()),
        created_at=datetime.now(timezone.utc),
        windows=1,
        attached=False,
        current_command="bash",
        is_codex_running=False,
    )
    duplicate = tmux_service.TmuxSessionInfo(
        name="release-dolphin",
        path=str(workspace.resolve()),
        created_at=datetime.now(timezone.utc),
        windows=1,
        attached=False,
        current_command="bash",
        is_codex_running=False,
    )

    async def fake_require_workspace_session(_workspace_path, _session_name):
        return old_session

    async def fake_list_all_sessions():
        return [old_session, duplicate]

    async def reject_tmux(*_args, **_kwargs):
        raise AssertionError("Duplicate handling must not mutate tmux.")

    monkeypatch.setattr(
        tmux_service,
        "require_workspace_session",
        fake_require_workspace_session,
    )
    monkeypatch.setattr(
        tmux_service,
        "list_all_sessions",
        fake_list_all_sessions,
    )
    monkeypatch.setattr(tmux_service, "_run_tmux", reject_tmux)

    with pytest.raises(
        tmux_service.TmuxServiceError,
        match="already exists",
    ):
        asyncio.run(
            tmux_service.rename_session(
                workspace,
                "Dolphin Tasks",
                old_session.name,
                "release",
            )
        )


def test_rename_session_maps_tmux_duplicate_race_to_conflict(
    tmp_path,
    monkeypatch,
):
    workspace = tmp_path / "project"
    workspace.mkdir()
    old_session = tmux_service.TmuxSessionInfo(
        name="review-dolphin",
        path=str(workspace.resolve()),
        created_at=datetime.now(timezone.utc),
        windows=1,
        attached=False,
        current_command="bash",
        is_codex_running=False,
    )

    async def fake_require_workspace_session(_workspace_path, _session_name):
        return old_session

    async def fake_list_all_sessions():
        return [old_session]

    async def fake_run_tmux(*_args, check=True):
        assert check is False
        return 1, "", "duplicate session: release-dolphin"

    monkeypatch.setattr(
        tmux_service,
        "require_workspace_session",
        fake_require_workspace_session,
    )
    monkeypatch.setattr(
        tmux_service,
        "list_all_sessions",
        fake_list_all_sessions,
    )
    monkeypatch.setattr(tmux_service, "_run_tmux", fake_run_tmux)

    with pytest.raises(tmux_service.TmuxServiceError) as error:
        asyncio.run(
            tmux_service.rename_session(
                workspace,
                "Dolphin Tasks",
                old_session.name,
                "release",
            )
        )

    assert error.value.status_code == 409
    assert "already exists" in error.value.detail


def test_rename_session_treats_unchanged_final_name_as_noop(
    tmp_path,
    monkeypatch,
):
    workspace = tmp_path / "project"
    workspace.mkdir()
    existing = tmux_service.TmuxSessionInfo(
        name="review-dolphin",
        path=str(workspace.resolve()),
        created_at=datetime.now(timezone.utc),
        windows=1,
        attached=False,
        current_command="bash",
        is_codex_running=False,
    )

    async def fake_require_workspace_session(_workspace_path, session_name):
        assert session_name == existing.name
        return existing

    async def reject_inventory():
        raise AssertionError("An unchanged rename must not need inventory.")

    async def reject_tmux(*_args, **_kwargs):
        raise AssertionError("An unchanged rename must not mutate tmux.")

    monkeypatch.setattr(
        tmux_service,
        "require_workspace_session",
        fake_require_workspace_session,
    )
    monkeypatch.setattr(tmux_service, "list_all_sessions", reject_inventory)
    monkeypatch.setattr(tmux_service, "_run_tmux", reject_tmux)

    result = asyncio.run(
        tmux_service.rename_session(
            workspace,
            "Dolphin Tasks",
            existing.name,
            "review",
        )
    )

    assert result == existing


def test_rename_session_rejects_invalid_name_before_workspace_or_tmux(
    tmp_path,
    monkeypatch,
):
    async def reject_workspace(*_args, **_kwargs):
        raise AssertionError("Invalid input must fail before workspace observation.")

    async def reject_tmux(*_args, **_kwargs):
        raise AssertionError("Invalid input must not mutate tmux.")

    monkeypatch.setattr(
        tmux_service,
        "require_workspace_session",
        reject_workspace,
    )
    monkeypatch.setattr(tmux_service, "_run_tmux", reject_tmux)

    with pytest.raises(
        tmux_service.TmuxServiceError,
        match="letters, numbers, dots, dashes, and underscores",
    ):
        asyncio.run(
            tmux_service.rename_session(
                tmp_path,
                "Dolphin Tasks",
                "review-dolphin",
                "unsafe:name",
            )
        )


def test_list_all_sessions_treats_missing_tmux_socket_as_empty(monkeypatch):
    # Other suites intentionally exercise the short-lived inventory cache.
    # This unit test owns the uncached socket-absence branch.
    tmux_service._SESSIONS_CACHE["data"] = None
    tmux_service._SESSIONS_CACHE["at"] = 0.0

    async def fake_run_tmux(*args, check=True):
        assert args[0] == "list-sessions"
        assert check is False
        return (
            1,
            "",
            "error connecting to /tmp/tmux-1001/default "
            "(No such file or directory)\n",
        )

    monkeypatch.setattr(tmux_service, "_run_tmux", fake_run_tmux)

    assert asyncio.run(tmux_service.list_all_sessions()) == []


def test_tmux_server_absence_detection_preserves_other_errors():
    assert tmux_service._tmux_server_is_absent(
        "no server running on /tmp/tmux-1001/default"
    )
    assert not tmux_service._tmux_server_is_absent(
        "error connecting to /tmp/tmux-1001/default (Permission denied)"
    )


def test_require_workspace_session_bypasses_stale_global_cache_for_exact_lookup(
    tmp_path,
    monkeypatch,
):
    workspace = tmp_path / "project"
    workspace.mkdir()
    expected = tmux_service.TmuxSessionInfo(
        name="dolphin-task-cache-regression",
        path=str(workspace.resolve()),
        created_at=datetime.now(timezone.utc),
        windows=1,
        attached=False,
        current_command="codex",
        is_codex_running=True,
    )
    uncached_calls = 0

    async def fake_list_all_sessions_uncached():
        nonlocal uncached_calls
        uncached_calls += 1
        return [expected]

    async def fake_pane_current_paths(session_name):
        assert session_name == expected.name
        return [workspace.resolve()]

    async def exercise():
        loop = asyncio.get_running_loop()
        monkeypatch.setitem(tmux_service._SESSIONS_CACHE, "data", [])
        monkeypatch.setitem(tmux_service._SESSIONS_CACHE, "at", loop.time())
        monkeypatch.setattr(
            tmux_service,
            "_list_all_sessions_uncached",
            fake_list_all_sessions_uncached,
        )
        monkeypatch.setattr(
            tmux_service,
            "pane_current_paths",
            fake_pane_current_paths,
        )
        return await tmux_service.require_workspace_session(
            workspace,
            expected.name,
        )

    assert asyncio.run(exercise()) == expected
    assert uncached_calls == 1


def test_activity_is_recent_uses_small_tmux_timestamp_window():
    observed_at = 1_000

    assert tmux_service._activity_is_recent("995", observed_at)
    assert not tmux_service._activity_is_recent("994", observed_at)
    assert not tmux_service._activity_is_recent("1001", observed_at)
    assert not tmux_service._activity_is_recent("not-a-timestamp", observed_at)


def test_stable_pane_identity_uses_one_read_only_tmux_batch(monkeypatch):
    calls: list[tuple[str, ...]] = []
    separator = tmux_service.FIELD_SEPARATOR

    async def fake_run_tmux(*args, check=True):
        assert check is False
        calls.append(args)
        return (
            0,
            separator.join(
                [
                    "/synthetic/tmux/socket",
                    "7100",
                    "$42",
                    "synthetic-renamed-session",
                    "%9",
                    "/synthetic/projects/alpha",
                    "codex",
                    "3102",
                ]
            )
            + "\n",
            "",
        )

    monkeypatch.setattr(tmux_service, "_run_tmux", fake_run_tmux)
    monkeypatch.setattr(
        tmux_service,
        "_read_proc_start_ticks",
        lambda pid: 4102 if pid == 3102 else None,
        raising=False,
    )
    monkeypatch.setattr(
        tmux_service,
        "_pane_pids_containing_supported_agents",
        lambda pane_pids: ({3102}, set()),
    )

    by_session, codex, claude, degraded = asyncio.run(
        tmux_service._load_all_pane_observations()
    )

    assert calls == [
        (
            "list-panes",
            "-a",
            "-F",
            separator.join(
                [
                    "#{socket_path}",
                    "#{pid}",
                    "#{session_id}",
                    "#{session_name}",
                    "#{pane_id}",
                    "#{pane_current_path}",
                    "#{pane_current_command}",
                    "#{pane_pid}",
                ]
            ),
        )
    ]
    assert codex == {3102}
    assert claude == set()
    assert degraded is False
    observation = by_session["synthetic-renamed-session"][0]
    assert observation.tmux_server_id == hashlib.sha256(
        b"/synthetic/tmux/socket\0server-pid=7100"
    ).hexdigest()
    assert observation.tmux_session_id == "$42"
    assert observation.session_name == "synthetic-renamed-session"
    assert observation.pane_id == "%9"
    assert observation.pid == 3102
    assert observation.pane_process_start_ticks == 4102
    assert observation.gaps == ()


def test_pane_identity_degrades_when_proc_start_is_unavailable(monkeypatch):
    separator = tmux_service.FIELD_SEPARATOR

    async def fake_run_tmux(*_args, **_kwargs):
        return (
            0,
            separator.join(
                [
                    "/synthetic/tmux/socket",
                    "7100",
                    "$42",
                    "synthetic-session",
                    "%9",
                    "/synthetic/projects/alpha",
                    "bash",
                    "3102",
                ]
            )
            + "\n",
            "",
        )

    monkeypatch.setattr(tmux_service, "_run_tmux", fake_run_tmux)
    monkeypatch.setattr(
        tmux_service,
        "_read_proc_start_ticks",
        lambda _pid: None,
        raising=False,
    )
    monkeypatch.setattr(
        tmux_service,
        "_pane_pids_containing_supported_agents",
        lambda _pane_pids: (set(), set()),
    )

    by_session, _codex, _claude, degraded = asyncio.run(
        tmux_service._load_all_pane_observations()
    )

    observation = by_session["synthetic-session"][0]
    assert observation.pane_process_start_ticks is None
    assert observation.degraded is True
    assert observation.gaps == ("proc_start_unavailable",)
    assert degraded is True


def test_pane_identity_fails_closed_when_pid_is_reused_during_observation(monkeypatch):
    separator = tmux_service.FIELD_SEPARATOR
    start_reads = iter([4102, 9999])

    async def fake_run_tmux(*_args, **_kwargs):
        return (
            0,
            separator.join(
                [
                    "/synthetic/tmux/socket",
                    "7100",
                    "$42",
                    "renamed-session",
                    "%9",
                    "/synthetic/projects/alpha",
                    "codex",
                    "3102",
                ]
            )
            + "\n",
            "",
        )

    monkeypatch.setattr(tmux_service, "_run_tmux", fake_run_tmux)
    monkeypatch.setattr(
        tmux_service,
        "_read_proc_start_ticks",
        lambda _pid: next(start_reads),
        raising=False,
    )
    monkeypatch.setattr(
        tmux_service,
        "_pane_pids_containing_supported_agents",
        lambda _pane_pids: ({3102}, set()),
    )

    by_session, codex, _claude, degraded = asyncio.run(
        tmux_service._load_all_pane_observations()
    )

    observation = by_session["renamed-session"][0]
    assert codex == set()
    assert observation.pane_process_start_ticks is None
    assert observation.degraded is True
    assert observation.gaps == ("pid_reuse",)
    assert degraded is True


def test_proc_start_parser_handles_parentheses_and_spaces(monkeypatch):
    fields_after_comm = ["S"] + [str(index) for index in range(4, 23)]
    fields_after_comm[-1] = "987654"
    monkeypatch.setattr(
        tmux_service,
        "_read_proc_stat_text",
        lambda pid: f"{pid} (synthetic agent (worker)) " + " ".join(fields_after_comm),
        raising=False,
    )

    assert tmux_service._read_proc_start_ticks(3202) == 987654


def test_open_fd_agent_observation_is_stable_and_bounded(monkeypatch):
    start_reads = iter([4202, 4202])
    process_visits: list[tuple[int, int]] = []

    monkeypatch.setattr(
        tmux_service,
        "_walk_process_tree",
        lambda root_pid, *, limit: iter((root_pid, 3202)),
    )
    monkeypatch.setattr(
        tmux_service,
        "_read_proc_executable_basename",
        lambda pid: "codex" if pid == 3202 else "bash",
    )
    monkeypatch.setattr(tmux_service, "_read_proc_process_name", lambda _pid: "")
    monkeypatch.setattr(
        tmux_service,
        "_read_proc_start_ticks",
        lambda _pid: next(start_reads),
        raising=False,
    )

    def fake_fd_identities(pid: int, *, limit: int):
        process_visits.append((pid, limit))
        return {(101, 202)}, False

    monkeypatch.setattr(
        tmux_service,
        "_read_proc_fd_identities",
        fake_fd_identities,
        raising=False,
    )

    result = tmux_service.observe_open_file_agent(
        3102,
        target_device=101,
        target_inode=202,
        process_limit=8,
        fd_limit=16,
    )

    assert result.agent_pid == 3202
    assert result.agent_process_start_ticks == 4202
    assert result.open_fd_process_start_ticks == 4202
    assert result.exact is True
    assert result.degraded is False
    assert result.gaps == ()
    assert process_visits == [(3202, 16)]


def test_open_fd_agent_observation_fails_closed_on_pid_reuse(monkeypatch):
    start_reads = iter([4202, 9999])
    monkeypatch.setattr(
        tmux_service,
        "_walk_process_tree",
        lambda root_pid, *, limit: iter((root_pid, 3202)),
    )
    monkeypatch.setattr(
        tmux_service,
        "_read_proc_executable_basename",
        lambda pid: "codex" if pid == 3202 else "bash",
    )
    monkeypatch.setattr(tmux_service, "_read_proc_process_name", lambda _pid: "")
    monkeypatch.setattr(
        tmux_service,
        "_read_proc_start_ticks",
        lambda _pid: next(start_reads),
        raising=False,
    )
    monkeypatch.setattr(
        tmux_service,
        "_read_proc_fd_identities",
        lambda _pid, *, limit: ({(101, 202)}, False),
        raising=False,
    )

    result = tmux_service.observe_open_file_agent(
        3102,
        target_device=101,
        target_inode=202,
    )

    assert result.exact is False
    assert result.degraded is True
    assert result.gaps == ("pid_reuse",)


def test_open_fd_agent_observation_reports_capped_proc_degradation(monkeypatch):
    fd_calls: list[int] = []
    monkeypatch.setattr(
        tmux_service,
        "_walk_process_tree",
        lambda root_pid, *, limit: iter((root_pid, 3201, 3202)[:limit]),
    )
    monkeypatch.setattr(tmux_service, "_read_proc_executable_basename", lambda _pid: "codex")
    monkeypatch.setattr(tmux_service, "_read_proc_process_name", lambda _pid: "")
    monkeypatch.setattr(
        tmux_service,
        "_read_proc_start_ticks",
        lambda pid: 4000 + pid,
        raising=False,
    )

    def capped_fds(pid: int, *, limit: int):
        fd_calls.append(pid)
        return set(), True

    monkeypatch.setattr(
        tmux_service,
        "_read_proc_fd_identities",
        capped_fds,
        raising=False,
    )

    result = tmux_service.observe_open_file_agent(
        3102,
        target_device=101,
        target_inode=202,
        process_limit=2,
        fd_limit=1,
    )

    assert result.exact is False
    assert result.degraded is True
    assert "process_limit_reached" in result.gaps
    assert "fd_limit_reached" in result.gaps
    assert len(fd_calls) <= 2


def test_create_codex_mode_bootstraps_shell_then_starts_and_refreshes(
    tmp_path,
    monkeypatch,
):
    workspace = tmp_path / "project"
    workspace.mkdir()
    session_name = "dolphin-codex-shell-first"
    shell = tmux_service.TmuxSessionInfo(
        name=session_name,
        path=str(workspace.resolve()),
        created_at=datetime.now(timezone.utc),
        windows=1,
        attached=False,
        current_command="bash",
        is_codex_running=False,
    )
    ready = tmux_service.TmuxSessionInfo(
        name=session_name,
        path=str(workspace.resolve()),
        created_at=shell.created_at,
        windows=1,
        attached=False,
        current_command="node",
        is_codex_running=True,
    )
    events: list[tuple] = []
    require_results = iter([shell, ready])
    real_sleep = asyncio.sleep

    async def fake_list_all_sessions():
        return []

    async def finished_process():
        return 0

    async def fake_spawn(*args: str):
        events.append(("spawn", args))
        return asyncio.create_task(finished_process())

    async def fake_sleep(delay: float):
        events.append(("sleep", delay))
        await real_sleep(0)

    async def fake_require(path: Path, name: str):
        result = next(require_results)
        events.append(("require", path, name, result.is_codex_running))
        return result

    async def fake_start_codex(path: Path, name: str):
        events.append(("start_codex", path, name))

    monkeypatch.setattr(tmux_service, "list_all_sessions", fake_list_all_sessions)
    monkeypatch.setattr(tmux_service, "_spawn_tmux_detached", fake_spawn)
    monkeypatch.setattr(tmux_service.asyncio, "sleep", fake_sleep)
    monkeypatch.setattr(
        tmux_service,
        "require_workspace_session",
        fake_require,
    )
    monkeypatch.setattr(tmux_service, "start_codex", fake_start_codex)

    result = asyncio.run(
        tmux_service.create_session(
            workspace,
            "Project",
            session_name,
            mode="codex",
        )
    )

    spawn_args = next(event[1] for event in events if event[0] == "spawn")
    assert spawn_args[-1] == str(workspace)
    assert "codex" not in spawn_args
    assert [event[0] for event in events if event[0] != "sleep"] == [
        "spawn",
        "require",
        "start_codex",
        "require",
    ]
    assert events[-2] == ("start_codex", workspace, session_name)
    assert result == ready


def test_create_claude_mode_bootstraps_shell_then_starts_and_refreshes(
    tmp_path,
    monkeypatch,
):
    workspace = tmp_path / "project"
    workspace.mkdir()
    session_name = "dolphin-claude-shell-first"
    shell = tmux_service.TmuxSessionInfo(
        name=session_name,
        path=str(workspace.resolve()),
        created_at=datetime.now(timezone.utc),
        windows=1,
        attached=False,
        current_command="bash",
        is_codex_running=False,
    )
    ready = tmux_service.TmuxSessionInfo(
        name=session_name,
        path=str(workspace.resolve()),
        created_at=shell.created_at,
        windows=1,
        attached=False,
        current_command="node",
        is_codex_running=False,
        is_claude_code_running=True,
    )
    events: list[tuple] = []
    require_results = iter([shell, ready])
    real_sleep = asyncio.sleep

    async def fake_list_all_sessions():
        return []

    async def finished_process():
        return 0

    async def fake_spawn(*args: str):
        events.append(("spawn", args))
        return asyncio.create_task(finished_process())

    async def fake_sleep(delay: float):
        events.append(("sleep", delay))
        await real_sleep(0)

    async def fake_require(path: Path, name: str):
        result = next(require_results)
        events.append(("require", path, name, result.is_claude_code_running))
        return result

    async def fake_start_claude(path: Path, name: str):
        events.append(("start_claude", path, name))

    monkeypatch.setattr(tmux_service, "list_all_sessions", fake_list_all_sessions)
    monkeypatch.setattr(tmux_service, "_spawn_tmux_detached", fake_spawn)
    monkeypatch.setattr(tmux_service.asyncio, "sleep", fake_sleep)
    monkeypatch.setattr(
        tmux_service,
        "require_workspace_session",
        fake_require,
    )
    monkeypatch.setattr(tmux_service, "start_claude", fake_start_claude)

    result = asyncio.run(
        tmux_service.create_session(
            workspace,
            "Project",
            session_name,
            mode="claude",
        )
    )

    spawn_args = next(event[1] for event in events if event[0] == "spawn")
    assert spawn_args[-1] == str(workspace)
    assert "claude" not in spawn_args
    assert [event[0] for event in events if event[0] != "sleep"] == [
        "spawn",
        "require",
        "start_claude",
        "require",
    ]
    assert events[-2] == ("start_claude", workspace, session_name)
    assert result == ready


def test_process_tree_contains_pattern_checks_descendants(monkeypatch):
    process_text = {
        100: "-bash",
        101: "python3 /home/user/.local/bin/codex-auto",
        102: "node /home/user/.npm-global/bin/codex",
    }

    monkeypatch.setattr(
        tmux_service,
        "_read_proc_command_text",
        lambda pid: process_text.get(pid, ""),
    )

    assert tmux_service._process_tree_contains_pattern(
        100,
        "codex",
        {
            100: [101],
            101: [102],
        },
    )


def test_process_tree_contains_pattern_ignores_unrelated_processes(monkeypatch):
    process_text = {
        100: "-bash",
        101: "python3 /tmp/other-tool",
        200: "node /home/user/.npm-global/bin/codex",
    }

    monkeypatch.setattr(
        tmux_service,
        "_read_proc_command_text",
        lambda pid: process_text.get(pid, ""),
    )

    assert not tmux_service._process_tree_contains_pattern(
        100,
        "codex",
        {
            100: [101],
            200: [],
        },
    )


def test_process_tree_native_executable_rejects_node_wrapper(monkeypatch):
    executable_names = {
        100: "bash",
        101: "node",
        102: "codex",
    }

    monkeypatch.setattr(
        tmux_service,
        "_read_proc_executable_basename",
        lambda pid: executable_names.get(pid, ""),
        raising=False,
    )

    assert not tmux_service._process_tree_contains_executable_basename(
        100,
        "codex",
        {
            100: [101],
        },
    )
    assert tmux_service._process_tree_contains_executable_basename(
        100,
        "codex",
        {
            100: [101],
            101: [102],
        },
    )


def test_supported_agent_scan_detects_versioned_claude_without_substring_false_positive(
    monkeypatch,
):
    children = {
        100: [101, 102],
        200: [201],
        300: [301],
    }
    executable_names = {
        100: "bash",
        101: "node",
        102: "codex",
        200: "bash",
        201: "2.1.220",
        300: "bash",
        301: "codex",
    }
    process_names = {
        100: "bash",
        101: "node",
        102: "codex",
        200: "bash",
        201: "claude",
        300: "bash",
        301: "codex",
    }
    command_text = {
        301: "codex implement support for Claude Code attachments",
    }

    monkeypatch.setattr(
        tmux_service,
        "_read_proc_child_pids",
        lambda pid: children.get(pid, []),
    )
    monkeypatch.setattr(
        tmux_service,
        "_read_proc_executable_basename",
        lambda pid: executable_names.get(pid, ""),
    )
    monkeypatch.setattr(
        tmux_service,
        "_read_proc_process_name",
        lambda pid: process_names.get(pid, ""),
        raising=False,
    )
    monkeypatch.setattr(
        tmux_service,
        "_read_proc_command_text",
        lambda pid: command_text.get(pid, ""),
    )

    codex_pids, claude_code_pids = (
        tmux_service._pane_pids_containing_supported_agents((100, 200, 300))
    )

    assert codex_pids == {100, 300}
    assert claude_code_pids == {200}


def test_build_session_info_reports_claude_code_separately_from_codex():
    observed_at = 1_000
    session = asyncio.run(
        tmux_service._build_session_info(
            [
                "dolphin-claude",
                "/tmp/project",
                "900",
                "1",
                "0",
                "999",
            ],
            observed_at,
            [
                tmux_service._PaneObservation(
                    path="/tmp/project",
                    current_command="claude",
                    pid=201,
                )
            ],
            set(),
            {201},
            False,
        )
    )

    assert session is not None
    assert session.is_codex_running is False
    assert session.is_claude_code_running is True
    assert session.observation_degraded is False


def test_start_codex_waits_for_native_executable_not_node_wrapper(monkeypatch):
    events: list[tuple] = []
    native_readiness = iter([False, True])
    workspace = Path("/tmp/project")
    session_name = "dolphin-task-native-ready"

    async def fake_require_workspace_session(path: Path, name: str):
        assert (path, name) == (workspace, session_name)
        return tmux_service.TmuxSessionInfo(
            name=name,
            path=str(path),
            created_at=datetime.now(timezone.utc),
            windows=1,
            attached=False,
            current_command="bash",
            is_codex_running=False,
        )

    async def fake_run_tmux(*args: str, check: bool = True):
        events.append(("run", args, check))
        return 0, "", ""

    async def fake_pane_contains_process(
        name: str,
        pattern: str,
        *,
        strict: bool = False,
    ):
        events.append(("broad", name, pattern, strict))
        return True

    async def fake_pane_contains_executable(
        name: str,
        executable_basename: str,
        *,
        strict: bool = False,
    ):
        ready = next(native_readiness)
        events.append(
            ("native", name, executable_basename, strict, ready)
        )
        return ready

    async def fake_sleep(delay: float):
        events.append(("sleep", delay))

    monkeypatch.setattr(
        tmux_service,
        "require_workspace_session",
        fake_require_workspace_session,
    )
    monkeypatch.setattr(tmux_service, "_run_tmux", fake_run_tmux)
    monkeypatch.setattr(
        tmux_service,
        "pane_contains_process",
        fake_pane_contains_process,
    )
    monkeypatch.setattr(
        tmux_service,
        "pane_contains_executable",
        fake_pane_contains_executable,
        raising=False,
    )
    monkeypatch.setattr(tmux_service.asyncio, "sleep", fake_sleep)

    asyncio.run(tmux_service.start_codex(workspace, session_name))

    assert [event for event in events if event[0] == "broad"] == []
    assert [event for event in events if event[0] == "native"] == [
        ("native", session_name, "codex", True, False),
        ("native", session_name, "codex", True, True),
    ]


def test_start_codex_waits_for_native_process_tree_readiness(monkeypatch):
    events: list[tuple] = []
    readiness = iter([False, True])

    async def fake_require_workspace_session(
        workspace_path: Path,
        session_name: str,
    ):
        events.append(("require", workspace_path, session_name))
        return tmux_service.TmuxSessionInfo(
            name=session_name,
            path=str(workspace_path),
            created_at=datetime.now(timezone.utc),
            windows=1,
            attached=False,
            current_command="bash",
            is_codex_running=False,
        )

    async def fake_run_tmux(*args: str, check: bool = True):
        events.append(("run", args, check))
        return 0, "", ""

    async def fake_pane_contains_executable(
        session_name: str,
        executable_basename: str,
        *,
        strict: bool = False,
    ):
        observed = next(readiness)
        events.append(
            ("observe", session_name, executable_basename, strict, observed)
        )
        return observed

    async def fake_sleep(delay: float):
        events.append(("sleep", delay))

    monkeypatch.setattr(
        tmux_service,
        "require_workspace_session",
        fake_require_workspace_session,
    )
    monkeypatch.setattr(tmux_service, "_run_tmux", fake_run_tmux)
    monkeypatch.setattr(
        tmux_service,
        "pane_contains_executable",
        fake_pane_contains_executable,
    )
    monkeypatch.setattr(tmux_service.asyncio, "sleep", fake_sleep)

    workspace = Path("/tmp/project")
    asyncio.run(tmux_service.start_codex(workspace, "dolphin-task-ready"))

    assert events[:3] == [
        (
            "require",
            workspace,
            "dolphin-task-ready",
        ),
        (
            "run",
            ("send-keys", "-t", "dolphin-task-ready", "-l", "codex"),
            True,
        ),
        (
            "run",
            ("send-keys", "-t", "dolphin-task-ready", "Enter"),
            True,
        ),
    ]
    assert [event for event in events if event[0] == "observe"] == [
        ("observe", "dolphin-task-ready", "codex", True, False),
        ("observe", "dolphin-task-ready", "codex", True, True),
    ]
    assert any(event[0] == "sleep" for event in events)


def test_start_codex_validates_then_sends_literal_command_without_settle_delay(
    monkeypatch,
):
    workspace = Path("/tmp/project")
    session_name = "dolphin-task-literal-codex"
    events: list[tuple] = []

    async def fake_require_workspace_session(path: Path, name: str):
        events.append(("require", path, name))
        return tmux_service.TmuxSessionInfo(
            name=name,
            path=str(path),
            created_at=datetime.now(timezone.utc),
            windows=1,
            attached=False,
            current_command="bash",
            is_codex_running=False,
        )

    async def fake_run_tmux(*args: str, check: bool = True):
        events.append(("run", args, check))
        return 0, "", ""

    async def fake_pane_contains_executable(
        name: str,
        executable_basename: str,
        *,
        strict: bool = False,
    ):
        events.append(("observe", name, executable_basename, strict))
        return True

    async def unexpected_send_input(*_args, **_kwargs):
        raise AssertionError("Fixed Codex startup must not use delayed prompt input")

    monkeypatch.setattr(
        tmux_service,
        "require_workspace_session",
        fake_require_workspace_session,
    )
    monkeypatch.setattr(tmux_service, "_run_tmux", fake_run_tmux)
    monkeypatch.setattr(
        tmux_service,
        "pane_contains_executable",
        fake_pane_contains_executable,
    )
    monkeypatch.setattr(tmux_service, "send_input", unexpected_send_input)

    asyncio.run(tmux_service.start_codex(workspace, session_name))

    assert events == [
        ("require", workspace, session_name),
        (
            "run",
            ("send-keys", "-t", session_name, "-l", "codex"),
            True,
        ),
        (
            "run",
            ("send-keys", "-t", session_name, "Enter"),
            True,
        ),
        ("observe", session_name, "codex", True),
    ]


def test_start_codex_shell_quotes_initial_prompt_as_positional_argument(
    monkeypatch,
):
    workspace = Path("/tmp/project")
    session_name = "dolphin-task-quoted-prompt"
    prompt = "Research the user's task\nDo not execute $(touch /tmp/not-run)"
    commands: list[tuple[str, ...]] = []

    async def fake_require_workspace_session(path: Path, name: str):
        assert (path, name) == (workspace, session_name)
        return tmux_service.TmuxSessionInfo(
            name=name,
            path=str(path),
            created_at=datetime.now(timezone.utc),
            windows=1,
            attached=False,
            current_command="bash",
            is_codex_running=False,
        )

    async def fake_run_tmux(*args: str, check: bool = True):
        assert check is True
        commands.append(args)
        return 0, "", ""

    async def fake_pane_contains_executable(
        name: str,
        executable_basename: str,
        *,
        strict: bool = False,
    ):
        assert (name, executable_basename, strict) == (
            session_name,
            "codex",
            True,
        )
        return True

    monkeypatch.setattr(
        tmux_service,
        "require_workspace_session",
        fake_require_workspace_session,
    )
    monkeypatch.setattr(tmux_service, "_run_tmux", fake_run_tmux)
    monkeypatch.setattr(
        tmux_service,
        "pane_contains_executable",
        fake_pane_contains_executable,
    )

    asyncio.run(
        tmux_service.start_codex(
            workspace,
            session_name,
            initial_prompt=prompt,
        )
    )

    assert commands == [
        (
            "send-keys",
            "-t",
            session_name,
            "-l",
            f"codex {shlex.quote(prompt)}",
        ),
        ("send-keys", "-t", session_name, "Enter"),
    ]
    assert shlex.split(commands[0][-1]) == ["codex", prompt]


def test_start_codex_timeout_is_bounded_and_preserves_shell(monkeypatch):
    observations = 0
    sleeps: list[float] = []
    commands: list[tuple[str, ...]] = []

    async def fake_require_workspace_session(
        workspace_path: Path,
        session_name: str,
    ):
        assert workspace_path == Path("/tmp/project")
        assert session_name == "dolphin-task-timeout"
        return tmux_service.TmuxSessionInfo(
            name=session_name,
            path=str(workspace_path),
            created_at=datetime.now(timezone.utc),
            windows=1,
            attached=False,
            current_command="bash",
            is_codex_running=False,
        )

    async def fake_run_tmux(*args: str, check: bool = True):
        assert check is True
        commands.append(args)
        return 0, "", ""

    async def fake_pane_contains_executable(
        session_name: str,
        executable_basename: str,
        *,
        strict: bool = False,
    ):
        nonlocal observations
        observations += 1
        assert (session_name, executable_basename, strict) == (
            "dolphin-task-timeout",
            "codex",
            True,
        )
        return False

    async def fake_sleep(delay: float):
        sleeps.append(delay)

    monkeypatch.setattr(
        tmux_service,
        "require_workspace_session",
        fake_require_workspace_session,
    )
    monkeypatch.setattr(tmux_service, "_run_tmux", fake_run_tmux)
    monkeypatch.setattr(
        tmux_service,
        "pane_contains_executable",
        fake_pane_contains_executable,
    )
    monkeypatch.setattr(tmux_service.asyncio, "sleep", fake_sleep)
    monkeypatch.setattr(tmux_service, "CODEX_START_TIMEOUT_SECONDS", 0.5)
    monkeypatch.setattr(tmux_service, "CODEX_START_POLL_SECONDS", 0.25)

    with pytest.raises(tmux_service.TmuxServiceError) as exc_info:
        asyncio.run(
            tmux_service.start_codex(
                Path("/tmp/project"),
                "dolphin-task-timeout",
            )
        )

    assert commands == [
        ("send-keys", "-t", "dolphin-task-timeout", "-l", "codex"),
        ("send-keys", "-t", "dolphin-task-timeout", "Enter"),
    ]
    assert observations == 3
    assert sleeps == [0.25, 0.25]
    assert exc_info.value.status_code == 503
    assert "dolphin-task-timeout" in exc_info.value.detail
    assert "within 0.5 seconds" in exc_info.value.detail
    assert "shell was kept open" in exc_info.value.detail
    assert "inspect its terminal output and retry" in exc_info.value.detail


# start_claude mirrors start_codex (spec §6.3): same two-call send-keys
# pattern, same readiness loop, same CODEX_START_* constants. These tests
# mirror the start_codex tests above, substituting "claude" for "codex" and
# adding coverage for the run_id -> DOLPHIN_RUN_ID environment prefix that
# start_codex does not carry by default.


def test_start_claude_waits_for_native_executable_not_node_wrapper(monkeypatch):
    events: list[tuple] = []
    native_readiness = iter([False, True])
    workspace = Path("/tmp/project")
    session_name = "dolphin-task-claude-native-ready"

    async def fake_require_workspace_session(path: Path, name: str):
        assert (path, name) == (workspace, session_name)
        return tmux_service.TmuxSessionInfo(
            name=name,
            path=str(path),
            created_at=datetime.now(timezone.utc),
            windows=1,
            attached=False,
            current_command="bash",
            is_codex_running=False,
        )

    async def fake_run_tmux(*args: str, check: bool = True):
        events.append(("run", args, check))
        return 0, "", ""

    async def fake_pane_contains_process(
        name: str,
        pattern: str,
        *,
        strict: bool = False,
    ):
        events.append(("broad", name, pattern, strict))
        return True

    async def fake_pane_contains_executable(
        name: str,
        executable_basename: str,
        *,
        strict: bool = False,
    ):
        ready = next(native_readiness)
        events.append(
            ("native", name, executable_basename, strict, ready)
        )
        return ready

    async def fake_sleep(delay: float):
        events.append(("sleep", delay))

    monkeypatch.setattr(
        tmux_service,
        "require_workspace_session",
        fake_require_workspace_session,
    )
    monkeypatch.setattr(tmux_service, "_run_tmux", fake_run_tmux)
    monkeypatch.setattr(
        tmux_service,
        "pane_contains_process",
        fake_pane_contains_process,
    )
    monkeypatch.setattr(
        tmux_service,
        "pane_contains_executable",
        fake_pane_contains_executable,
        raising=False,
    )
    monkeypatch.setattr(tmux_service.asyncio, "sleep", fake_sleep)

    asyncio.run(tmux_service.start_claude(workspace, session_name))

    assert [event for event in events if event[0] == "broad"] == []
    assert [event for event in events if event[0] == "native"] == [
        ("native", session_name, "claude", True, False),
        ("native", session_name, "claude", True, True),
    ]


def test_start_claude_waits_for_native_process_tree_readiness(monkeypatch):
    events: list[tuple] = []
    readiness = iter([False, True])

    async def fake_require_workspace_session(
        workspace_path: Path,
        session_name: str,
    ):
        events.append(("require", workspace_path, session_name))
        return tmux_service.TmuxSessionInfo(
            name=session_name,
            path=str(workspace_path),
            created_at=datetime.now(timezone.utc),
            windows=1,
            attached=False,
            current_command="bash",
            is_codex_running=False,
        )

    async def fake_run_tmux(*args: str, check: bool = True):
        events.append(("run", args, check))
        return 0, "", ""

    async def fake_pane_contains_executable(
        session_name: str,
        executable_basename: str,
        *,
        strict: bool = False,
    ):
        observed = next(readiness)
        events.append(
            ("observe", session_name, executable_basename, strict, observed)
        )
        return observed

    async def fake_sleep(delay: float):
        events.append(("sleep", delay))

    monkeypatch.setattr(
        tmux_service,
        "require_workspace_session",
        fake_require_workspace_session,
    )
    monkeypatch.setattr(tmux_service, "_run_tmux", fake_run_tmux)
    monkeypatch.setattr(
        tmux_service,
        "pane_contains_executable",
        fake_pane_contains_executable,
    )
    monkeypatch.setattr(tmux_service.asyncio, "sleep", fake_sleep)

    workspace = Path("/tmp/project")
    asyncio.run(tmux_service.start_claude(workspace, "dolphin-task-claude-ready"))

    assert events[:3] == [
        (
            "require",
            workspace,
            "dolphin-task-claude-ready",
        ),
        (
            "run",
            ("send-keys", "-t", "dolphin-task-claude-ready", "-l", "claude"),
            True,
        ),
        (
            "run",
            ("send-keys", "-t", "dolphin-task-claude-ready", "Enter"),
            True,
        ),
    ]
    assert [event for event in events if event[0] == "observe"] == [
        ("observe", "dolphin-task-claude-ready", "claude", True, False),
        ("observe", "dolphin-task-claude-ready", "claude", True, True),
    ]
    assert any(event[0] == "sleep" for event in events)


def test_start_claude_validates_then_sends_literal_command_without_settle_delay(
    monkeypatch,
):
    workspace = Path("/tmp/project")
    session_name = "dolphin-task-literal-claude"
    events: list[tuple] = []

    async def fake_require_workspace_session(path: Path, name: str):
        events.append(("require", path, name))
        return tmux_service.TmuxSessionInfo(
            name=name,
            path=str(path),
            created_at=datetime.now(timezone.utc),
            windows=1,
            attached=False,
            current_command="bash",
            is_codex_running=False,
        )

    async def fake_run_tmux(*args: str, check: bool = True):
        events.append(("run", args, check))
        return 0, "", ""

    async def fake_pane_contains_executable(
        name: str,
        executable_basename: str,
        *,
        strict: bool = False,
    ):
        events.append(("observe", name, executable_basename, strict))
        return True

    async def unexpected_send_input(*_args, **_kwargs):
        raise AssertionError(
            "Fixed Claude Code startup must not use delayed prompt input"
        )

    monkeypatch.setattr(
        tmux_service,
        "require_workspace_session",
        fake_require_workspace_session,
    )
    monkeypatch.setattr(tmux_service, "_run_tmux", fake_run_tmux)
    monkeypatch.setattr(
        tmux_service,
        "pane_contains_executable",
        fake_pane_contains_executable,
    )
    monkeypatch.setattr(tmux_service, "send_input", unexpected_send_input)

    asyncio.run(tmux_service.start_claude(workspace, session_name))

    assert events == [
        ("require", workspace, session_name),
        (
            "run",
            ("send-keys", "-t", session_name, "-l", "claude"),
            True,
        ),
        (
            "run",
            ("send-keys", "-t", session_name, "Enter"),
            True,
        ),
        ("observe", session_name, "claude", True),
    ]


def test_start_claude_shell_quotes_initial_prompt_and_carries_run_id(
    monkeypatch,
):
    workspace = Path("/tmp/project")
    session_name = "dolphin-task-quoted-claude-prompt"
    prompt = "Research the user's task\nDo not execute $(touch /tmp/not-run)"
    commands: list[tuple[str, ...]] = []

    async def fake_require_workspace_session(path: Path, name: str):
        assert (path, name) == (workspace, session_name)
        return tmux_service.TmuxSessionInfo(
            name=name,
            path=str(path),
            created_at=datetime.now(timezone.utc),
            windows=1,
            attached=False,
            current_command="bash",
            is_codex_running=False,
        )

    async def fake_run_tmux(*args: str, check: bool = True):
        assert check is True
        commands.append(args)
        return 0, "", ""

    async def fake_pane_contains_executable(
        name: str,
        executable_basename: str,
        *,
        strict: bool = False,
    ):
        assert (name, executable_basename, strict) == (
            session_name,
            "claude",
            True,
        )
        return True

    monkeypatch.setattr(
        tmux_service,
        "require_workspace_session",
        fake_require_workspace_session,
    )
    monkeypatch.setattr(tmux_service, "_run_tmux", fake_run_tmux)
    monkeypatch.setattr(
        tmux_service,
        "pane_contains_executable",
        fake_pane_contains_executable,
    )

    asyncio.run(
        tmux_service.start_claude(
            workspace,
            session_name,
            initial_prompt=prompt,
            run_id="RUN789",
        )
    )

    assert commands == [
        (
            "send-keys",
            "-t",
            session_name,
            "-l",
            f"DOLPHIN_RUN_ID=RUN789 claude {shlex.quote(prompt)}",
        ),
        ("send-keys", "-t", session_name, "Enter"),
    ]
    assert shlex.split(commands[0][-1]) == [
        "DOLPHIN_RUN_ID=RUN789",
        "claude",
        prompt,
    ]


def test_start_claude_timeout_is_bounded_and_preserves_shell(monkeypatch):
    observations = 0
    sleeps: list[float] = []
    commands: list[tuple[str, ...]] = []

    async def fake_require_workspace_session(
        workspace_path: Path,
        session_name: str,
    ):
        assert workspace_path == Path("/tmp/project")
        assert session_name == "dolphin-task-claude-timeout"
        return tmux_service.TmuxSessionInfo(
            name=session_name,
            path=str(workspace_path),
            created_at=datetime.now(timezone.utc),
            windows=1,
            attached=False,
            current_command="bash",
            is_codex_running=False,
        )

    async def fake_run_tmux(*args: str, check: bool = True):
        assert check is True
        commands.append(args)
        return 0, "", ""

    async def fake_pane_contains_executable(
        session_name: str,
        executable_basename: str,
        *,
        strict: bool = False,
    ):
        nonlocal observations
        observations += 1
        assert (session_name, executable_basename, strict) == (
            "dolphin-task-claude-timeout",
            "claude",
            True,
        )
        return False

    async def fake_sleep(delay: float):
        sleeps.append(delay)

    monkeypatch.setattr(
        tmux_service,
        "require_workspace_session",
        fake_require_workspace_session,
    )
    monkeypatch.setattr(tmux_service, "_run_tmux", fake_run_tmux)
    monkeypatch.setattr(
        tmux_service,
        "pane_contains_executable",
        fake_pane_contains_executable,
    )
    monkeypatch.setattr(tmux_service.asyncio, "sleep", fake_sleep)
    monkeypatch.setattr(tmux_service, "CODEX_START_TIMEOUT_SECONDS", 0.5)
    monkeypatch.setattr(tmux_service, "CODEX_START_POLL_SECONDS", 0.25)

    with pytest.raises(tmux_service.TmuxServiceError) as exc_info:
        asyncio.run(
            tmux_service.start_claude(
                Path("/tmp/project"),
                "dolphin-task-claude-timeout",
            )
        )

    assert commands == [
        ("send-keys", "-t", "dolphin-task-claude-timeout", "-l", "claude"),
        ("send-keys", "-t", "dolphin-task-claude-timeout", "Enter"),
    ]
    assert observations == 3
    assert sleeps == [0.25, 0.25]
    assert exc_info.value.status_code == 503
    assert "dolphin-task-claude-timeout" in exc_info.value.detail
    assert "within 0.5 seconds" in exc_info.value.detail
    assert "shell was kept open" in exc_info.value.detail
    assert "inspect its terminal output and retry" in exc_info.value.detail


def test_send_input_submits_with_carriage_return_after_text(monkeypatch):
    calls = []
    sleeps = []

    async def fake_require_workspace_session(workspace_path, session_name):
        return None

    async def fake_run_tmux(*args, check=True):
        calls.append(("run", args))
        return 0, "", ""

    async def fake_run_tmux_with_input(*args, input_text, check=True):
        calls.append(("run_with_input", args, input_text))
        return 0, "", ""

    async def fake_sleep(delay):
        sleeps.append(delay)

    monkeypatch.setattr(
        tmux_service,
        "require_workspace_session",
        fake_require_workspace_session,
    )
    monkeypatch.setattr(tmux_service, "_run_tmux", fake_run_tmux)
    monkeypatch.setattr(
        tmux_service,
        "_run_tmux_with_input",
        fake_run_tmux_with_input,
    )
    monkeypatch.setattr(tmux_service.asyncio, "sleep", fake_sleep)

    asyncio.run(
        tmux_service.send_input(Path("/tmp/project"), "dolphin-example", "prompt")
    )

    assert calls[0][0] == "run_with_input"
    assert calls[0][1][:3] == ("load-buffer", "-b", calls[0][1][2])
    assert calls[0][1][3] == "-"
    assert calls[0][1][2].startswith("dolphin-input-")
    assert calls[0][2] == "prompt"
    assert calls[1] == (
        "run",
        ("send-keys", "-t", "dolphin-example", "-X", "cancel"),
    )
    assert calls[2] == (
        "run",
        (
            "paste-buffer",
            "-d",
            "-p",
            "-r",
            "-b",
            calls[0][1][2],
            "-t",
            "dolphin-example",
            ";",
            "send-keys",
            "-t",
            "dolphin-example",
            "C-m",
        ),
    )
    assert len(calls) == 3
    assert sleeps == [5]


def test_send_input_does_not_submit_when_before_enter_cancels(monkeypatch):
    calls = []
    sleeps = []
    checks = []

    async def fake_require_workspace_session(_workspace_path, _session_name):
        return None

    async def fake_run_tmux(*args, check=True):
        calls.append(("run", args))
        return 0, "", ""

    async def fake_run_tmux_with_input(*args, input_text, check=True):
        calls.append(("run_with_input", args, input_text))
        return 0, "", ""

    async def fake_sleep(delay):
        sleeps.append(delay)

    async def cancel_before_enter():
        checks.append("before_enter")
        return False

    monkeypatch.setattr(
        tmux_service,
        "require_workspace_session",
        fake_require_workspace_session,
    )
    monkeypatch.setattr(tmux_service, "_run_tmux", fake_run_tmux)
    monkeypatch.setattr(
        tmux_service,
        "_run_tmux_with_input",
        fake_run_tmux_with_input,
    )
    monkeypatch.setattr(tmux_service.asyncio, "sleep", fake_sleep)

    sent = asyncio.run(
        tmux_service.send_input(
            Path("/tmp/project"),
            "dolphin-example",
            "draft prompt",
            before_enter=cancel_before_enter,
        )
    )

    assert sent is False
    assert sleeps == [5]
    assert checks == ["before_enter"]
    assert calls[0][0] == "run_with_input"
    assert calls[1] == (
        "run",
        ("delete-buffer", "-b", calls[0][1][2]),
    )
    assert all("paste-buffer" not in call[1] for call in calls)


def test_send_input_requires_codex_before_paste_and_before_submit(monkeypatch):
    calls = []
    observations = []
    workspace = Path("/tmp/project")
    session = tmux_service.TmuxSessionInfo(
        name="dolphin-exact",
        path=str(workspace),
        created_at=datetime.now(timezone.utc),
        windows=1,
        attached=False,
        current_command="node",
        is_codex_running=True,
    )

    async def fake_require_workspace_session(workspace_path, session_name):
        observations.append((workspace_path, session_name))
        return session

    async def fake_run_tmux(*args, check=True):
        calls.append(("run", args))
        return 0, "", ""

    async def fake_run_tmux_with_input(*args, input_text, check=True):
        calls.append(("run_with_input", args, input_text))
        return 0, "", ""

    async def fake_sleep(_delay):
        return None

    monkeypatch.setattr(
        tmux_service,
        "require_workspace_session",
        fake_require_workspace_session,
    )
    monkeypatch.setattr(tmux_service, "_run_tmux", fake_run_tmux)
    monkeypatch.setattr(
        tmux_service,
        "_run_tmux_with_input",
        fake_run_tmux_with_input,
    )
    monkeypatch.setattr(tmux_service.asyncio, "sleep", fake_sleep)

    asyncio.run(
        tmux_service.send_input(
            workspace,
            session.name,
            "first line\nsecond line",
            require_codex=True,
        )
    )

    assert observations == [
        (workspace, session.name),
        (workspace, session.name),
    ]
    assert calls[0][2] == "first line\nsecond line"
    assert calls[1] == (
        "run",
        ("send-keys", "-t", session.name, "-X", "cancel"),
    )
    assert calls[2][1][0:4] == ("paste-buffer", "-d", "-p", "-r")
    assert calls[2][1][-5:] == (";", "send-keys", "-t", session.name, "C-m")
    assert len(calls) == 3


@pytest.mark.parametrize(
    ("degraded", "codex_running", "expected_status", "expected_detail"),
    [
        (True, False, 503, "safely verify"),
        (False, False, 409, "Codex is not running"),
    ],
)
def test_send_input_rejects_unverified_or_plain_shell_target(
    monkeypatch,
    degraded,
    codex_running,
    expected_status,
    expected_detail,
):
    session = tmux_service.TmuxSessionInfo(
        name="dolphin-exact",
        path="/tmp/project",
        created_at=datetime.now(timezone.utc),
        windows=1,
        attached=False,
        current_command=None if degraded else "bash",
        is_codex_running=codex_running,
        observation_degraded=degraded,
    )

    async def fake_require_workspace_session(_workspace_path, _session_name):
        return session

    async def fail_if_called(*_args, **_kwargs):
        raise AssertionError("tmux must not receive input without verified Codex")

    monkeypatch.setattr(
        tmux_service,
        "require_workspace_session",
        fake_require_workspace_session,
    )
    monkeypatch.setattr(tmux_service, "_run_tmux", fail_if_called)
    monkeypatch.setattr(tmux_service, "_run_tmux_with_input", fail_if_called)

    with pytest.raises(tmux_service.TmuxServiceError) as exc_info:
        asyncio.run(
            tmux_service.send_input(
                Path("/tmp/project"),
                session.name,
                "approval",
                require_codex=True,
            )
        )

    assert exc_info.value.status_code == expected_status
    assert expected_detail in exc_info.value.detail


def test_send_input_does_not_submit_if_codex_disappears_after_paste(monkeypatch):
    calls = []
    workspace = Path("/tmp/project")
    ready = tmux_service.TmuxSessionInfo(
        name="dolphin-exact",
        path=str(workspace),
        created_at=datetime.now(timezone.utc),
        windows=1,
        attached=False,
        current_command="node",
        is_codex_running=True,
    )
    shell = tmux_service.TmuxSessionInfo(
        name=ready.name,
        path=ready.path,
        created_at=ready.created_at,
        windows=1,
        attached=False,
        current_command="bash",
        is_codex_running=False,
    )
    observations = iter([ready, shell])

    async def fake_require_workspace_session(_workspace_path, _session_name):
        return next(observations)

    async def fake_run_tmux(*args, check=True):
        calls.append(("run", args))
        return 0, "", ""

    async def fake_run_tmux_with_input(*args, input_text, check=True):
        calls.append(("run_with_input", args, input_text))
        return 0, "", ""

    async def fake_sleep(_delay):
        return None

    monkeypatch.setattr(
        tmux_service,
        "require_workspace_session",
        fake_require_workspace_session,
    )
    monkeypatch.setattr(tmux_service, "_run_tmux", fake_run_tmux)
    monkeypatch.setattr(
        tmux_service,
        "_run_tmux_with_input",
        fake_run_tmux_with_input,
    )
    monkeypatch.setattr(tmux_service.asyncio, "sleep", fake_sleep)

    with pytest.raises(tmux_service.TmuxServiceError) as exc_info:
        asyncio.run(
            tmux_service.send_input(
                workspace,
                ready.name,
                "approval",
                require_codex=True,
            )
        )

    assert exc_info.value.status_code == 409
    assert not any(
        call[0] == "run" and call[1][0] == "send-keys"
        for call in calls
    )


def test_require_codex_session_names_claude_code_when_that_is_what_is_running(
    monkeypatch,
):
    """"Codex is not running in the linked task session" is technically true
    but names the wrong agent when Claude Code is what is actually running
    (the case tracked runs now dispatch into) -- and it is the operator's
    only signal for an entire untracked dispatch class.
    """
    session = tmux_service.TmuxSessionInfo(
        name="dolphin-exact",
        path="/tmp/project",
        created_at=datetime.now(timezone.utc),
        windows=1,
        attached=False,
        current_command="claude",
        is_codex_running=False,
        is_claude_code_running=True,
    )

    async def fake_require_workspace_session(_workspace_path, _session_name):
        return session

    async def fail_if_called(*_args, **_kwargs):
        raise AssertionError("tmux must not receive input without verified Codex")

    monkeypatch.setattr(
        tmux_service, "require_workspace_session", fake_require_workspace_session
    )
    monkeypatch.setattr(tmux_service, "_run_tmux", fail_if_called)
    monkeypatch.setattr(tmux_service, "_run_tmux_with_input", fail_if_called)

    with pytest.raises(tmux_service.TmuxServiceError) as exc_info:
        asyncio.run(
            tmux_service.send_input(
                Path("/tmp/project"),
                session.name,
                "approval",
                require_codex=True,
            )
        )

    assert exc_info.value.status_code == 409
    assert "Claude Code is running" in exc_info.value.detail
    assert "not Codex" in exc_info.value.detail


def test_build_session_info_carries_absolute_last_activity_time():
    observed_at = 1_000_000
    session = asyncio.run(
        tmux_service._build_session_info(
            ["dolphin-idle", "/tmp/project", "900000", "1", "0", "913600"],
            observed_at,
            [
                tmux_service._PaneObservation(
                    path="/tmp/project",
                    current_command="node",
                    pid=301,
                )
            ],
            {301},
            set(),
            False,
        )
    )

    assert session is not None
    assert session.last_activity_at == datetime.fromtimestamp(913_600, tz=timezone.utc)
    # The five-second liveness flag keeps its own, separate meaning.
    assert session.has_recent_activity is False


def test_build_session_info_tolerates_unparseable_activity_time():
    session = asyncio.run(
        tmux_service._build_session_info(
            ["dolphin-odd", "/tmp/project", "900000", "1", "0", "not-a-number"],
            1_000_000,
            [
                tmux_service._PaneObservation(
                    path="/tmp/project",
                    current_command="bash",
                    pid=302,
                )
            ],
            set(),
            set(),
            False,
        )
    )

    assert session is not None
    assert session.last_activity_at is None
    assert session.has_recent_activity is False


def test_claude_readiness_recognizes_version_named_native_binary(monkeypatch):
    monkeypatch.setattr(tmux_service, '_read_proc_executable_basename', lambda pid: 'bash' if pid == 100 else '2.1.278')
    monkeypatch.setattr(tmux_service, '_read_proc_process_name', lambda pid: 'bash' if pid == 100 else 'claude')
    tree = {100: [101]}
    assert tmux_service._process_tree_contains_executable_basename(100, 'claude', tree)
    assert not tmux_service._process_tree_contains_executable_basename(100, 'codex', tree)
