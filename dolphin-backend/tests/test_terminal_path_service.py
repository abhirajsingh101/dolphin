"""Resolving path-shaped tokens scraped out of terminal output.

Terminal output is untrusted text. Everything here is about what happens when
a string that wants to be a path meets a filesystem: what escapes, what is a
symlink, what does not exist, and what is simply outside the roots.
"""

import asyncio
import importlib
import os
from pathlib import Path

import pytest


def _service():
    """Import lazily so the first RED run can target the missing module."""
    return importlib.import_module("app.terminal_path_service")


@pytest.fixture(autouse=True)
def isolated_temp_root(tmp_path, monkeypatch):
    """Point the service's /tmp at a private directory for every test.

    pytest's own tmp_path lives under the real /tmp and is owned by the test
    user, so without this every "outside the roots" fixture would quietly
    become a downloadable temp file.
    """
    temp_root = tmp_path / "tmp"
    monkeypatch.setattr(_service(), "TEMP_ROOT", temp_root)
    return temp_root


@pytest.fixture
def roots(tmp_path, monkeypatch):
    workspace = tmp_path / "workspace"
    (workspace / "src").mkdir(parents=True)
    (workspace / "src" / "api.ts").write_text("export {};\n")
    (workspace / "notes.md").write_text("hello\n")
    (workspace / "link.ts").symlink_to(workspace / "src" / "api.ts")
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.txt").write_text("nope\n")
    monkeypatch.setenv("DOLPHIN_WORKSPACE_ROOTS", str(workspace))
    return workspace, outside


def test_resolves_absolute_relative_and_home_candidates(roots, monkeypatch):
    service = _service()
    workspace, _ = roots
    monkeypatch.setenv("HOME", str(workspace))

    resolved = {
        item.candidate: item
        for item in service.resolve_terminal_paths(
            [
                str(workspace / "notes.md"),
                "src/api.ts",
                "~/notes.md",
                "src",
                "link.ts",
                "src/gone.ts",
            ],
            bases=[workspace],
        )
    }

    assert resolved[str(workspace / "notes.md")].kind == "file"
    assert resolved[str(workspace / "notes.md")].size_bytes == 6
    assert resolved["src/api.ts"].kind == "file"
    assert resolved["src/api.ts"].path == str(workspace / "src" / "api.ts")
    assert resolved["~/notes.md"].kind == "file"
    assert resolved["src"].kind == "directory"
    assert resolved["link.ts"].kind == "symlink"
    assert resolved["src/gone.ts"].kind == "missing"


def test_resolves_global_home_data_and_project_local_paths(tmp_path, monkeypatch):
    """The live service exposes both machine roots, while relative paths still
    belong to the active pane/project and must resolve through those bases."""
    service = _service()
    home_root = tmp_path / "home" / "user"
    data_root = tmp_path / "data" / "user"
    project = home_root / "projects" / "alpha"
    pane_cwd = project / "packages" / "web"
    pane_cwd.mkdir(parents=True)
    data_root.mkdir(parents=True)
    (home_root / "global.md").write_text("home\n")
    (data_root / "brain.md").write_text("data\n")
    (project / "README.md").write_text("project\n")
    (pane_cwd / "local.ts").write_text("pane\n")
    monkeypatch.setenv(
        "DOLPHIN_WORKSPACE_ROOTS",
        f"{home_root}{os.pathsep}{data_root}",
    )

    resolved = {
        item.candidate: item
        for item in service.resolve_terminal_paths(
            [
                str(home_root / "global.md"),
                str(data_root / "brain.md"),
                "README.md",
                "local.ts",
            ],
            bases=[pane_cwd, project],
        )
    }

    assert resolved[str(home_root / "global.md")].kind == "file"
    assert resolved[str(data_root / "brain.md")].kind == "file"
    assert resolved["README.md"].path == str(project / "README.md")
    assert resolved["local.ts"].path == str(pane_cwd / "local.ts")


def test_resolves_owned_private_claude_scratchpad_files(tmp_path, monkeypatch):
    service = _service()
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    temp_parent = tmp_path / "tmp"
    claude_root = temp_parent / f"claude-{os.getuid()}"
    scratchpad = (
        claude_root
        / "-data-user-projects-slides"
        / "f83599a6-18d9-469a-9a7b-35803425da7a"
        / "scratchpad"
    )
    scratchpad.mkdir(parents=True, mode=0o700)
    claude_root.chmod(0o700)
    artifact = scratchpad / "soma_merged.pptx"
    artifact.write_bytes(b"pptx")
    monkeypatch.setenv("DOLPHIN_WORKSPACE_ROOTS", str(workspace))
    monkeypatch.setattr(service, "TEMP_ROOT", temp_parent)

    resolved = service.resolve_terminal_paths([str(artifact)], bases=[workspace])[0]

    assert resolved == service.ResolvedTerminalPath(
        candidate=str(artifact),
        path=str(artifact),
        kind="file",
        size_bytes=4,
    )
    root, relative = service.resolve_download_target(str(artifact))
    assert root == claude_root
    assert relative == (
        "-data-user-projects-slides/"
        "f83599a6-18d9-469a-9a7b-35803425da7a/"
        "scratchpad/soma_merged.pptx"
    )


def test_claude_temp_access_is_limited_to_private_scratchpad_shape(
    tmp_path,
    monkeypatch,
):
    service = _service()
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    temp_parent = tmp_path / "tmp"
    claude_root = temp_parent / f"claude-{os.getuid()}"
    session = claude_root / "-project" / "f83599a6-18d9-469a-9a7b-35803425da7a"
    scratchpad = session / "scratchpad"
    scratchpad.mkdir(parents=True, mode=0o700)
    claude_root.chmod(0o700)
    wrong_area = session / "transcript.jsonl"
    wrong_area.write_text("private\n")
    malformed_session = claude_root / "-project" / "not-a-session" / "scratchpad"
    malformed_session.mkdir(parents=True)
    malformed_file = malformed_session / "artifact.pptx"
    malformed_file.write_bytes(b"pptx")
    outside = tmp_path / "outside"
    escaped_scratchpad = (
        outside / "f83599a6-18d9-469a-9a7b-35803425da7a" / "scratchpad"
    )
    escaped_scratchpad.mkdir(parents=True)
    escaped_file = escaped_scratchpad / "escaped.pptx"
    escaped_file.write_bytes(b"pptx")
    (claude_root / "-escape").symlink_to(outside, target_is_directory=True)
    escaped_candidate = (
        claude_root
        / "-escape"
        / "f83599a6-18d9-469a-9a7b-35803425da7a"
        / "scratchpad"
        / "escaped.pptx"
    )
    monkeypatch.setenv("DOLPHIN_WORKSPACE_ROOTS", str(workspace))
    monkeypatch.setattr(service, "TEMP_ROOT", temp_parent)

    denied = service.resolve_terminal_paths(
        [str(wrong_area), str(malformed_file), str(escaped_candidate)],
        bases=[workspace],
    )
    assert [item.kind for item in denied] == ["denied", "denied", "denied"]

    from app.workspace_file_service import WorkspaceFileError

    with pytest.raises(WorkspaceFileError) as exc_info:
        service.resolve_download_target(str(escaped_candidate))
    assert exc_info.value.status_code == 403

    claude_root.chmod(0o755)
    artifact = scratchpad / "artifact.pptx"
    artifact.write_bytes(b"pptx")
    assert service.resolve_terminal_paths(
        [str(artifact)], bases=[workspace]
    )[0].kind == "denied"
    with pytest.raises(WorkspaceFileError) as exc_info:
        service.resolve_download_target(str(artifact))
    assert exc_info.value.status_code == 403


def test_resolves_and_downloads_files_the_user_created_under_tmp(
    roots,
    isolated_temp_root,
):
    """Agents write screenshots and scratch output to /tmp constantly."""
    service = _service()
    from app import main
    from app.workspace_file_service import WorkspaceFileError

    workspace, _ = roots
    shots = isolated_temp_root / "app-screenshots"
    shots.mkdir(parents=True, mode=0o700)
    image = shots / "03-today.png"
    image.write_bytes(b"png")
    (isolated_temp_root / "escape").symlink_to(workspace, target_is_directory=True)
    (shots / "link.png").symlink_to(image)

    resolved = service.resolve_terminal_paths(
        [
            str(image),
            str(isolated_temp_root / "escape" / "notes.md"),
            str(shots / "link.png"),
        ],
        bases=[workspace],
    )
    assert resolved[0] == service.ResolvedTerminalPath(
        candidate=str(image), path=str(image), kind="file", size_bytes=3
    )
    assert [item.kind for item in resolved[1:]] == ["denied", "symlink"]

    assert service.resolve_download_target(str(image)) == (
        isolated_temp_root,
        "app-screenshots/03-today.png",
    )
    for candidate in [
        str(isolated_temp_root / "escape" / "notes.md"),
        str(shots / "link.png"),
        str(isolated_temp_root),
    ]:
        with pytest.raises(WorkspaceFileError) as exc_info:
            service.resolve_download_target(candidate)
        assert exc_info.value.status_code == 403, candidate

    async def download_body() -> bytes:
        response = await main.download_workspace_file(path=str(image))
        return b"".join([chunk async for chunk in response.body_iterator])

    assert asyncio.run(download_body()) == b"png"


def test_tmp_files_another_user_owns_are_denied(
    roots,
    isolated_temp_root,
    monkeypatch,
):
    """/tmp is shared with every local account; only the user's own files pass."""
    service = _service()
    from app import main
    from fastapi import HTTPException
    from app.workspace_file_service import WorkspaceFileError

    workspace, _ = roots
    theirs = isolated_temp_root / "their-build" / "report.pdf"
    theirs.parent.mkdir(parents=True)
    theirs.write_bytes(b"pdf")
    monkeypatch.setattr(service, "_current_uid", lambda: os.getuid() + 1)

    assert service.resolve_terminal_paths(
        [str(theirs)], bases=[workspace]
    )[0].kind == "denied"
    with pytest.raises(WorkspaceFileError) as exc_info:
        service.resolve_download_target(str(theirs))
    assert exc_info.value.status_code == 403
    with pytest.raises(HTTPException) as http_info:
        asyncio.run(main.download_workspace_file(path=str(theirs)))
    assert http_info.value.status_code == 403


def test_tmp_download_rechecks_the_owner_of_the_file_it_opened(
    isolated_temp_root,
    monkeypatch,
):
    """Checking the path and then opening it leaves a window for a swap.

    Whatever the earlier checks saw, the descriptor that is actually streamed
    must belong to the user.
    """
    service = _service()
    from app.workspace_file_service import WorkspaceFileError

    swapped = isolated_temp_root / "shared" / "swapped.txt"
    swapped.parent.mkdir(parents=True)
    swapped.write_text("someone else's\n")
    monkeypatch.setattr(
        service,
        "resolve_download_target",
        lambda raw_path: (isolated_temp_root, "shared/swapped.txt"),
    )
    monkeypatch.setattr(service, "_current_uid", lambda: os.getuid() + 1)

    with pytest.raises(WorkspaceFileError) as exc_info:
        service.open_download_target(str(swapped))
    assert exc_info.value.status_code == 403


def test_relative_candidates_prefer_the_first_base(roots):
    service = _service()
    workspace, _ = roots
    (workspace / "src" / "notes.md").write_text("nested\n")

    resolved = service.resolve_terminal_paths(
        ["notes.md"],
        bases=[workspace / "src", workspace],
    )

    assert resolved[0].path == str(workspace / "src" / "notes.md")


def test_a_later_base_still_wins_over_a_miss_in_an_earlier_one(roots):
    """A miss in the pane's cwd must not shadow a hit in the project root."""
    service = _service()
    workspace, _ = roots

    resolved = service.resolve_terminal_paths(
        ["notes.md"],
        bases=[workspace / "src", workspace],
    )

    assert resolved[0].kind == "file"
    assert resolved[0].path == str(workspace / "notes.md")


def test_refuses_candidates_outside_the_workspace_roots(roots):
    service = _service()
    workspace, outside = roots

    resolved = service.resolve_terminal_paths(
        [
            str(outside / "secret.txt"),
            "../outside/secret.txt",
            "/etc/passwd",
            "src/../../outside/secret.txt",
        ],
        bases=[workspace],
    )

    assert [item.kind for item in resolved] == ["denied"] * 4
    assert all(item.path is None for item in resolved)


def test_rejects_oversized_and_malformed_candidates(roots):
    service = _service()
    workspace, _ = roots

    resolved = service.resolve_terminal_paths(
        ["x" * (service.MAX_CANDIDATE_LENGTH + 1), "with\x00nul", ""],
        bases=[workspace],
    )

    assert [item.kind for item in resolved] == ["denied", "denied", "denied"]


def test_caps_the_candidate_list(roots):
    service = _service()
    workspace, _ = roots

    resolved = service.resolve_terminal_paths(
        [f"file-{index}.txt" for index in range(service.MAX_CANDIDATES + 50)],
        bases=[workspace],
    )

    assert len(resolved) == service.MAX_CANDIDATES


def test_download_target_accepts_files_and_refuses_everything_else(roots):
    service = _service()
    from app.workspace_file_service import WorkspaceFileError

    workspace, outside = roots

    root, relative = service.resolve_download_target(
        str(workspace / "src" / "api.ts")
    )
    assert root == workspace
    assert relative == "src/api.ts"

    for candidate, status in [
        (str(outside / "secret.txt"), 403),
        (str(workspace / "link.ts"), 403),
        (str(workspace / "src"), 415),
        (str(workspace / "gone.ts"), 404),
        ("relative/path.txt", 400),
        (str(workspace), 403),
    ]:
        with pytest.raises(WorkspaceFileError) as exc_info:
            service.resolve_download_target(candidate)
        assert exc_info.value.status_code == status, candidate


def test_download_target_cannot_be_laundered_through_a_symlinked_parent(
    tmp_path,
    monkeypatch,
):
    """The check that lexical normalisation exists to protect.

    ``Path.resolve()`` here would follow ``inside/escape`` out to the secret
    and then find the *resolved* path outside the root — but only after the
    containment check had already passed on the pre-resolution string. The
    dir-fd walk refuses the symlinked component instead.
    """
    service = _service()
    from app.workspace_file_service import WorkspaceFileError

    workspace = tmp_path / "workspace"
    (workspace / "inside").mkdir(parents=True)
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.txt").write_text("nope\n")
    (workspace / "inside" / "escape").symlink_to(outside, target_is_directory=True)
    monkeypatch.setenv("DOLPHIN_WORKSPACE_ROOTS", str(workspace))

    with pytest.raises(WorkspaceFileError) as exc_info:
        service.resolve_download_target(
            str(workspace / "inside" / "escape" / "secret.txt")
        )
    assert exc_info.value.status_code == 403

    resolved = service.resolve_terminal_paths(
        ["inside/escape/secret.txt"],
        bases=[workspace],
    )
    assert resolved[0].kind == "denied"


# --- Routes ------------------------------------------------------------------


def test_project_files_api_routes_are_removed():
    from app import main

    routes = [
        route.path
        for route in main.app.routes
        if route.path.startswith("/api/projects/{project_id}/files")
    ]
    assert routes == []


def test_download_route_streams_an_attachment(roots):
    from app import main
    from fastapi import HTTPException

    workspace, outside = roots
    (workspace / "archive.bin").write_bytes(b"\x00\x01\x02")

    async def download_body(target: str) -> tuple[bytes, dict[str, str]]:
        response = await main.download_workspace_file(path=target)
        chunks = [chunk async for chunk in response.body_iterator]
        body = b"".join(
            chunk if isinstance(chunk, bytes) else chunk.encode() for chunk in chunks
        )
        return body, response.headers

    body, headers = asyncio.run(download_body(str(workspace / "archive.bin")))

    assert body == b"\x00\x01\x02"
    assert headers["content-disposition"].startswith("attachment")
    assert "archive.bin" in headers["content-disposition"]
    assert headers["content-type"] == "application/octet-stream"
    assert headers["x-content-type-options"] == "nosniff"
    assert headers["content-length"] == "3"

    for candidate, status in [
        (str(outside / "secret.txt"), 403),
        (str(workspace / "link.ts"), 403),
        (str(workspace / "src"), 415),
        ("relative.txt", 400),
    ]:
        with pytest.raises(HTTPException) as exc_info:
            asyncio.run(main.download_workspace_file(path=candidate))
        assert exc_info.value.status_code == status, candidate


def test_resolve_route_derives_bases_from_the_pane_then_the_project(
    roots,
    monkeypatch,
):
    from app import main, schemas
    from app.models import Project

    workspace, _ = roots
    (workspace / "src" / "only-here.md").write_text("nested\n")

    async def fake_get_project(project_id, db):
        assert project_id == "project-1"
        return Project(id="project-1", name="P", path=str(workspace))

    async def fake_pane_paths(session_name, **kwargs):
        assert session_name == "codex"
        return [workspace / "src"]

    monkeypatch.setattr(main, "_get_project_or_404", fake_get_project)
    monkeypatch.setattr(main, "pane_current_paths", fake_pane_paths)

    response = asyncio.run(
        main.resolve_terminal_path_candidates(
            "project-1",
            schemas.TerminalPathResolveRequest(
                session_name="codex",
                candidates=["only-here.md", "notes.md", "/etc/passwd"],
            ),
            db=None,
        )
    )

    by_candidate = {item.candidate: item for item in response.paths}
    # Only resolvable through the pane's cwd, so the pane base must be tried.
    assert by_candidate["only-here.md"].kind == "file"
    assert by_candidate["only-here.md"].path == str(
        workspace / "src" / "only-here.md"
    )
    # Only resolvable through the project root, so both bases must be tried.
    assert by_candidate["notes.md"].kind == "file"
    assert by_candidate["notes.md"].path == str(workspace / "notes.md")
    assert by_candidate["/etc/passwd"].kind == "denied"


def test_resolve_route_survives_a_session_tmux_cannot_inspect(roots, monkeypatch):
    from app import main, schemas
    from app.models import Project
    from app.tmux_service import TmuxServiceError

    workspace, _ = roots

    async def fake_get_project(project_id, db):
        return Project(id="project-1", name="P", path=str(workspace))

    async def fake_pane_paths(session_name, **kwargs):
        raise TmuxServiceError("no server running")

    monkeypatch.setattr(main, "_get_project_or_404", fake_get_project)
    monkeypatch.setattr(main, "pane_current_paths", fake_pane_paths)

    response = asyncio.run(
        main.resolve_terminal_path_candidates(
            "project-1",
            schemas.TerminalPathResolveRequest(
                session_name="dead",
                candidates=["notes.md"],
            ),
            db=None,
        )
    )

    assert response.paths[0].kind == "file"
