"""Process observation without Linux's /proc (macOS), through psutil.

DOLPHIN_PROC_FALLBACK forces that path here. The pane runs on a private tmux
server (a scratch TMUX_TMPDIR, TMUX unset), never the user's.
"""

from __future__ import annotations

import asyncio
import shutil

import pytest

from app import tmux_service as t


@pytest.mark.asyncio
async def test_agents_and_pane_status_are_observed_without_proc(tmp_path, monkeypatch):
    scratch = tmp_path / "tmux"
    scratch.mkdir()
    monkeypatch.setenv("TMUX_TMPDIR", str(scratch))
    monkeypatch.delenv("TMUX", raising=False)
    monkeypatch.delenv("TMUX_PANE", raising=False)
    monkeypatch.setenv("DOLPHIN_PROC_FALLBACK", "1")
    claude = tmp_path / "claude"
    shutil.copy("/bin/sleep", claude)
    assert not t._has_proc()
    try:
        await t._run_tmux("new-session", "-d", "-s", "probe", "-c", str(tmp_path))
        await t._run_tmux("send-keys", "-t", "probe", f"{claude} 300", "Enter")
        for _ in range(30):
            if await t.pane_contains_executable("probe", "claude", strict=True):
                break
            await asyncio.sleep(0.2)
        assert await t.pane_contains_executable("probe", "claude", strict=True)

        by_session, *_ = await t._load_all_pane_observations()
        pane = by_session["probe"][0]
        assert pane.degraded is False, pane.gaps
        assert t._read_proc_start_ticks(pane.pid) is not None
        assert t._proc_identity(pane.pid) is not None
        session = next(s for s in await t.list_all_sessions() if s.name == "probe")
        assert session.is_claude_code_running
    finally:
        await t._run_tmux("kill-server", check=False)
