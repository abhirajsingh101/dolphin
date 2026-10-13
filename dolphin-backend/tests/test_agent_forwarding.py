"""SSH agent forwarding into new tmux sessions. A private tmux server (scratch
TMUX_TMPDIR, TMUX unset, scratch HOME, /bin/sh), never the user's."""

from __future__ import annotations

import asyncio
import shutil

import pytest

from app import tmux_service as t
from app.terminal_attach import installed_tmux_version

pytestmark = pytest.mark.skipif(shutil.which("tmux") is None, reason="tmux is not installed")


def _private_tmux(tmp_path, monkeypatch):
    scratch = tmp_path / "tmux"
    scratch.mkdir()
    monkeypatch.setenv("TMUX_TMPDIR", str(scratch))
    monkeypatch.delenv("TMUX", raising=False)
    monkeypatch.delenv("TMUX_PANE", raising=False)
    # tmux's default update-environment copies the client's agent into a new
    # session, which would defeat the "nothing is set" test on a machine with one.
    monkeypatch.delenv("SSH_AUTH_SOCK", raising=False)
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("SHELL", "/bin/sh")
    monkeypatch.setenv("DOLPHIN_WORKSPACE_ROOTS", str(tmp_path))
    t._invalidate_sessions_cache()
    work = tmp_path / "work"
    work.mkdir()
    return work


@pytest.mark.asyncio
async def test_new_sessions_get_the_forwarded_agent_link(tmp_path, monkeypatch):
    work = _private_tmux(tmp_path, monkeypatch)
    helper_home = tmp_path / "helper"
    (helper_home / "run").mkdir(parents=True)
    link = helper_home / "run" / "agent.sock"
    link.symlink_to(tmp_path / "agent-not-here-yet")  # dangling is fine: the app re-points it on connect
    monkeypatch.setenv("DOLPHIN_HELPER_VERSION", "test")
    monkeypatch.setenv("DOLPHIN_HOME", str(helper_home))
    assert t.agent_socket_link() == link
    try:
        session = await t.create_session(work, "proj", requested_name="fwd")
        _, out, _ = await t._run_tmux("show-environment", "-t", session.name, "SSH_AUTH_SOCK")
        assert out.strip() == f"SSH_AUTH_SOCK={link}"
        if await installed_tmux_version(t.tmux_binary()) >= (3, 2):
            marker = work / "sock.txt"
            await t._run_tmux("send-keys", "-t", session.name, f'printf %s "$SSH_AUTH_SOCK" > {marker}', "Enter")
            for _ in range(50):
                if marker.exists() and marker.read_text():
                    break
                await asyncio.sleep(0.1)
            assert marker.read_text() == str(link), "the first window has it too"
        # the server's global environment is never changed
        code, gout, _ = await t._run_tmux("show-environment", "-g", "SSH_AUTH_SOCK", check=False)
        assert code != 0 or gout.strip().startswith("-")
    finally:
        await t._run_tmux("kill-server", check=False)  # this test's private server
        t._invalidate_sessions_cache()


@pytest.mark.asyncio
async def test_without_the_link_nothing_is_set(tmp_path, monkeypatch):
    work = _private_tmux(tmp_path, monkeypatch)
    monkeypatch.setenv("DOLPHIN_HELPER_VERSION", "test")
    monkeypatch.setenv("DOLPHIN_HOME", str(tmp_path / "helper"))
    assert t.agent_socket_link() is None
    try:
        session = await t.create_session(work, "proj", requested_name="plain")
        code, out, _ = await t._run_tmux("show-environment", "-t", session.name, "SSH_AUTH_SOCK", check=False)
        assert code != 0 or out.strip().startswith("-")
    finally:
        await t._run_tmux("kill-server", check=False)
        t._invalidate_sessions_cache()


def test_outside_helper_mode_there_is_no_link(tmp_path, monkeypatch):
    (tmp_path / "run").mkdir()
    (tmp_path / "run" / "agent.sock").symlink_to(tmp_path / "x")
    monkeypatch.setenv("DOLPHIN_HOME", str(tmp_path))
    monkeypatch.delenv("DOLPHIN_HELPER_VERSION", raising=False)
    assert t.agent_socket_link() is None
