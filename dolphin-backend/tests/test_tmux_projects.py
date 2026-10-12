"""Dolphin Desktop: projects for the tmux sessions already running on a machine."""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi.testclient import TestClient

from app import tmux_projects
from app.tmux_service import TmuxSessionInfo


def _session(name: str, path, panes=()) -> TmuxSessionInfo:
    return TmuxSessionInfo(
        name=name, path=str(path), created_at=datetime.now(tz=timezone.utc), windows=1,
        attached=False, current_command="bash", is_codex_running=False,
        pane_paths=tuple(str(p) for p in panes),
    )


def _tree(root):
    (root / "projects" / "app" / ".git").mkdir(parents=True)
    (root / "projects" / "app" / "src" / "deep").mkdir(parents=True)
    (root / "notes").mkdir()
    (root / ".config" / "tool").mkdir(parents=True)
    (root / "projects" / "linked" / "sub").mkdir(parents=True)
    return root.resolve()


def test_sessions_map_to_their_repository_or_folder(tmp_path, monkeypatch):
    root = _tree(tmp_path)
    monkeypatch.setenv("DOLPHIN_WORKSPACE_ROOTS", str(root))
    sessions = [
        _session("deep", root / "projects" / "app" / "src" / "deep"),  # inside a repo: the repo
        _session("app", root / "projects" / "app"),
        _session("notes", root / "notes"),  # no repo: the folder
        _session("home", root, panes=[root / "notes"]),  # started at home, working in notes
        _session("hidden", root / ".config" / "tool"),
        _session("outside", "/"),
        _session("gone", root / "missing"),
        _session("linked", root / "projects" / "linked" / "sub"),  # already shows under its project
        _session("seen", root / "projects" / "app"),
    ]
    found = tmux_projects.plan(sessions, [str(root / "projects" / "linked")], set())
    assert found == {
        str(root / "projects" / "app"): ["deep", "app", "seen"],
        str(root / "notes"): ["notes", "home"],
    }
    # A folder imported before (and perhaps removed since) is not brought back.
    assert tmux_projects.plan(sessions, [], {str(root / "projects" / "app"), str(root / "notes"), str(root / "projects" / "linked")}) == {}


def test_endpoint_adds_each_folder_once(tmp_path, monkeypatch):
    from app import tmux_service
    from app.main import app

    root = _tree(tmp_path / "home")
    monkeypatch.setenv("DOLPHIN_WORKSPACE_ROOTS", str(root))
    monkeypatch.setenv("DOLPHIN_HOME", str(tmp_path / "helper"))
    monkeypatch.setenv("DOLPHIN_HELPER_VERSION", "test")
    sessions = [_session("app", root / "projects" / "app"), _session("notes", root / "notes")]

    async def fake_sessions():
        return sessions

    monkeypatch.setattr(tmux_service, "list_all_sessions", fake_sessions)
    with TestClient(app) as client:
        first = client.post("/api/desktop/tmux-projects").json()["added"]
        assert [(p["name"], p["sessions"]) for p in first] == [("app", ["app"]), ("notes", ["notes"])]
        names = [p["name"] for p in client.get("/api/projects").json()]
        assert "app" in names and "notes" in names

        # Removed by the user: stays removed on the next connect.
        client.delete(f"/api/projects/{first[1]['id']}")
        assert client.post("/api/desktop/tmux-projects").json() == {"added": []}

        for project in first[:1]:
            client.delete(f"/api/projects/{project['id']}")

    monkeypatch.delenv("DOLPHIN_HELPER_VERSION")
    with TestClient(app) as client:
        assert client.post("/api/desktop/tmux-projects").status_code == 404
