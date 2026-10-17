"""Plain terminals (app/plain_terminals.py): a shell in the project folder with
no tmux, listed and driven like a session. And picking an agent (app/agents.py):
whichever of Claude Code and Codex is installed."""

from __future__ import annotations

import time

import pytest
from fastapi.testclient import TestClient

from app import agent_clis, agents, plain_terminals, tmux_service


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("DOLPHIN_HOME", str(tmp_path / "dolphin"))
    from app.main import app

    root = tmp_path / "projects"
    (root / "app").mkdir(parents=True)
    monkeypatch.setenv("DOLPHIN_WORKSPACE_ROOTS", str(root))
    monkeypatch.setenv("SHELL", "/bin/sh")

    async def no_tmux():
        return []

    monkeypatch.setattr(tmux_service, "_list_tmux_sessions", no_tmux)
    with TestClient(app) as test_client:
        project = test_client.post("/api/projects", json={"name": "app", "path": str(root / "app")}).json()
        yield test_client, project
        test_client.delete(f"/api/projects/{project['id']}")
    plain_terminals.close_all()


def _until(read, wanted: bytes, limit: float = 10) -> bytes:
    seen = b""
    deadline = time.monotonic() + limit
    while wanted not in seen and time.monotonic() < deadline:
        seen += read()
    return seen


def test_a_terminal_is_a_shell_in_the_project_folder_listed_like_a_session(client):
    test_client, project = client
    base = f"/api/projects/{project['id']}/tmux/sessions"
    created = test_client.post(base, json={"mode": "terminal"})
    assert created.status_code == 201, created.text
    name = created.json()["name"]
    assert name.startswith("term:") and created.json()["path"] == project["path"]
    assert name in [session["name"] for session in test_client.get(base).json()]

    with test_client.websocket_connect(f"{base}/{name}/stream") as socket:
        socket.send_json({"type": "resize", "cols": 100, "rows": 30})
        socket.send_bytes(b"echo hello-$((40+2))\r")
        assert b"hello-42" in _until(socket.receive_bytes, b"hello-42")

    # The shell kept running without a window; a new one sees what it printed.
    assert test_client.post(f"{base}/{name}/input", json={"text": "pwd"}).status_code == 200
    with test_client.websocket_connect(f"{base}/{name}/stream") as socket:
        socket.send_json({"type": "resize", "cols": 100, "rows": 30})
        replay = _until(socket.receive_bytes, project["path"].encode())
        assert b"hello-42" in replay and project["path"].encode() in replay

    snapshot = test_client.get(f"{base}/{name}/snapshot").json()
    assert "hello-42" in snapshot["content"] and "\x1b" not in snapshot["content"]
    assert test_client.patch(f"{base}/{name}", json={"name": "other"}).status_code >= 400

    assert test_client.delete(f"{base}/{name}").status_code == 204
    assert name not in [session["name"] for session in test_client.get(base).json()]


def test_a_terminal_belongs_to_its_own_project_only(client, tmp_path):
    test_client, project = client
    (tmp_path / "projects" / "other").mkdir()
    other = test_client.post("/api/projects", json={"name": "other", "path": str(tmp_path / "projects" / "other")}).json()
    try:
        name = test_client.post(f"/api/projects/{project['id']}/tmux/sessions", json={"mode": "terminal"}).json()["name"]
        assert test_client.get(f"/api/projects/{other['id']}/tmux/sessions/{name}/snapshot").status_code >= 400
        assert test_client.delete(f"/api/projects/{other['id']}/tmux/sessions/{name}").status_code >= 400
    finally:
        test_client.delete(f"/api/projects/{other['id']}")


def _installed(monkeypatch, *names):
    monkeypatch.setattr(agent_clis, "locate", lambda refresh=False: {
        tool: f"/bin/{tool}" if tool in names else None for tool in ("claude", "codex", "npm", "brew")})


def test_the_preferred_agent_is_used_when_installed_and_the_other_otherwise(monkeypatch):
    _installed(monkeypatch, "claude", "codex")
    assert agents.order("codex") == ["codex", "claude"] and agents.pick("claude") == "claude"
    _installed(monkeypatch, "codex")
    assert agents.pick("claude") == "codex"
    assert agents.substitute("claude") == ("codex", "Claude Code isn't installed on this machine, so this session started Codex.")
    assert agents.substitute("shell") == ("shell", None) and agents.substitute("terminal") == ("terminal", None)
    _installed(monkeypatch)
    assert agents.pick("codex") is None and agents.substitute("codex") == ("codex", None)


def test_a_terminal_number_is_never_reused_after_a_restart(client, monkeypatch):
    test_client, project = client
    base = f"/api/projects/{project['id']}/tmux/sessions"
    first = test_client.post(base, json={"mode": "terminal"}).json()["name"]
    plain_terminals.close_all()  # the helper stopped; its terminals ended
    second = test_client.post(base, json={"mode": "terminal"}).json()["name"]
    assert int(second.split(":")[1]) > int(first.split(":")[1])


def test_agents_are_never_started_in_a_plain_terminal(client):
    test_client, project = client
    base = f"/api/projects/{project['id']}/tmux/sessions"
    name = test_client.post(base, json={"mode": "terminal"}).json()["name"]
    response = test_client.post(f"{base}/{name}/codex")
    assert response.status_code >= 400 and "plain terminal" in response.json()["detail"]


def test_a_large_paste_reaches_the_shell_without_blocking(client):
    test_client, project = client
    base = f"/api/projects/{project['id']}/tmux/sessions"
    name = test_client.post(base, json={"mode": "terminal"}).json()["name"]
    with test_client.websocket_connect(f"{base}/{name}/stream") as socket:
        socket.send_json({"type": "resize", "cols": "wide", "rows": 30})  # malformed: ignored, not fatal
        socket.send_json({"type": "resize", "cols": 100, "rows": 30})
        socket.send_bytes(b"cat > /dev/null\r" + b"x" * 200_000 + b"\r\x04echo done-$((1+1))\r")
        assert b"done-2" in _until(socket.receive_bytes, b"done-2", limit=20)
