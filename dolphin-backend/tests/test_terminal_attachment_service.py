import asyncio
import importlib
import os
import re
import time
import zipfile
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import quote

import pytest
from fastapi import HTTPException
from fastapi.routing import APIRoute
from PIL import Image, PngImagePlugin


def _service():
    """Import inside tests so the RED run targets the new generic service."""
    return importlib.import_module("app.terminal_attachment_service")


def _png_bytes(*, metadata: bool = False) -> bytes:
    image = Image.new("RGBA", (3, 2), (12, 34, 56, 200))
    output = BytesIO()
    pnginfo = None
    if metadata:
        pnginfo = PngImagePlugin.PngInfo()
        pnginfo.add_text("Comment", "private metadata")
    image.save(output, format="PNG", pnginfo=pnginfo)
    image.close()
    return output.getvalue()


@pytest.mark.asyncio
async def test_store_keeps_an_opaque_file_private_with_a_generated_name(
    tmp_path,
    monkeypatch,
):
    service = _service()
    root = tmp_path / "terminal-attachments"
    monkeypatch.setenv("DOLPHIN_TERMINAL_ATTACHMENT_ROOT", str(root))
    payload = b"meeting notes\nline two\n"

    stored = await service.store_terminal_attachment(
        project_id="project-alpha",
        original_name="meeting notes.txt",
        content_type="text/plain; charset=utf-8",
        data=payload,
    )

    path = Path(stored.path)
    assert path.parent == root.resolve() / "project-alpha"
    assert path.name != "meeting notes.txt"
    assert re.fullmatch(r"[0-9a-f]{32}\.txt", path.name)
    assert path.read_bytes() == payload
    assert path.stat().st_mode & 0o777 == 0o600
    assert path.parent.stat().st_mode & 0o777 == 0o700
    assert stored.original_name == "meeting notes.txt"
    assert stored.kind == "file"
    assert stored.content_type == "text/plain"
    assert stored.width is None
    assert stored.height is None
    assert stored.expires_at > stored.created_at


@pytest.mark.asyncio
async def test_generic_store_still_sanitizes_png_content(
    tmp_path,
    monkeypatch,
):
    service = _service()
    root = tmp_path / "terminal-attachments"
    monkeypatch.setenv("DOLPHIN_TERMINAL_ATTACHMENT_ROOT", str(root))

    stored = await service.store_terminal_attachment(
        project_id="project-alpha",
        original_name="capture.png",
        content_type="application/octet-stream",
        data=_png_bytes(metadata=True),
    )

    path = Path(stored.path)
    assert stored.kind == "image"
    assert stored.content_type == "image/png"
    assert stored.width == 3
    assert stored.height == 2
    with Image.open(path, formats=["PNG"]) as sanitized:
        sanitized.load()
        assert sanitized.size == (3, 2)
        assert "Comment" not in sanitized.info


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("original_name", "data", "status_code"),
    [
        ("../private.txt", b"safe bytes", 400),
        ("folder/private.txt", b"safe bytes", 400),
        ("bad\x00name.txt", b"safe bytes", 400),
        ("empty.txt", b"", 400),
        ("large.bin", b"12345", 413),
    ],
)
async def test_generic_store_rejects_unsafe_names_empty_and_oversized_files(
    tmp_path,
    monkeypatch,
    original_name,
    data,
    status_code,
):
    service = _service()
    root = tmp_path / "terminal-attachments"
    monkeypatch.setenv("DOLPHIN_TERMINAL_ATTACHMENT_ROOT", str(root))
    monkeypatch.setenv("DOLPHIN_TERMINAL_ATTACHMENT_MAX_BYTES", "4")

    with pytest.raises(service.TerminalAttachmentError) as exc_info:
        await service.store_terminal_attachment(
            project_id="project-alpha",
            original_name=original_name,
            content_type="application/octet-stream",
            data=data,
        )

    assert exc_info.value.status_code == status_code
    assert not root.exists()


@pytest.mark.asyncio
async def test_explicit_cleanup_removes_expired_managed_and_temp_files_only(
    tmp_path,
    monkeypatch,
):
    service = _service()
    root = tmp_path / "terminal-attachments"
    monkeypatch.setenv("DOLPHIN_TERMINAL_ATTACHMENT_ROOT", str(root))
    monkeypatch.setenv("DOLPHIN_TERMINAL_ATTACHMENT_RETENTION_SECONDS", "60")

    expired = await service.store_terminal_attachment(
        project_id="project-alpha",
        original_name="expired.txt",
        content_type="text/plain",
        data=b"expired",
    )
    active = await service.store_terminal_attachment(
        project_id="project-alpha",
        original_name="active.pdf",
        content_type="application/pdf",
        data=b"%PDF-active",
    )
    removable = await service.store_terminal_attachment(
        project_id="project-empty",
        original_name="expired.bin",
        content_type="application/octet-stream",
        data=b"expired",
    )

    project_root = Path(expired.path).parent
    temp_path = project_root / f".{'a' * 32}.{'b' * 32}.tmp"
    temp_path.write_bytes(b"stale temp")
    unmanaged = project_root / "keep-me.txt"
    unmanaged.write_text("not managed by Dolphin")
    outside = tmp_path / "outside.txt"
    outside.write_text("outside")
    symlink = project_root / "outside-link"
    symlink.symlink_to(outside)
    old_time = time.time() - 120
    for path in (Path(expired.path), Path(removable.path), temp_path):
        os.utime(path, (old_time, old_time))

    result = await service.prune_terminal_attachments()

    assert result.deleted_files == 2
    assert result.deleted_temp_files == 1
    assert not Path(expired.path).exists()
    assert not Path(removable.path).exists()
    assert not temp_path.exists()
    assert Path(active.path).exists()
    assert unmanaged.read_text() == "not managed by Dolphin"
    assert symlink.is_symlink()
    assert outside.read_text() == "outside"
    assert not (root / "project-empty").exists()


def test_generic_environment_overrides_legacy_image_environment(
    tmp_path,
    monkeypatch,
):
    service = _service()
    generic_root = tmp_path / "generic"
    legacy_root = tmp_path / "legacy"
    monkeypatch.setenv("DOLPHIN_TERMINAL_ATTACHMENT_ROOT", str(generic_root))
    monkeypatch.setenv("DOLPHIN_TERMINAL_IMAGE_ROOT", str(legacy_root))
    monkeypatch.setenv("DOLPHIN_TERMINAL_ATTACHMENT_MAX_BYTES", "1234")
    monkeypatch.setenv("DOLPHIN_TERMINAL_IMAGE_MAX_BYTES", "5678")

    settings = service.terminal_attachment_settings()

    assert settings.root == generic_root.resolve()
    assert settings.max_attachment_bytes == 1234
    assert settings.max_image_bytes == 1234


def test_default_limits_allow_600_mib_per_file_and_one_full_batch(
    monkeypatch,
):
    service = _service()
    for name in (
        "DOLPHIN_TERMINAL_ATTACHMENT_MAX_BYTES",
        "DOLPHIN_TERMINAL_IMAGE_MAX_BYTES",
        "DOLPHIN_TERMINAL_ATTACHMENT_MAX_STORAGE_BYTES",
        "DOLPHIN_TERMINAL_IMAGE_MAX_STORAGE_BYTES",
    ):
        monkeypatch.delenv(name, raising=False)

    settings = service.terminal_attachment_settings()

    assert settings.max_attachment_bytes == 600 * 1024 * 1024
    assert settings.max_storage_bytes == 4 * 1024 * 1024 * 1024
    assert settings.max_storage_bytes > 4 * settings.max_attachment_bytes


@pytest.mark.asyncio
async def test_stream_store_publishes_exact_limit_without_joining_chunks(
    tmp_path,
    monkeypatch,
):
    service = _service()
    root = tmp_path / "terminal-attachments"
    monkeypatch.setenv("DOLPHIN_TERMINAL_ATTACHMENT_ROOT", str(root))
    monkeypatch.setenv("DOLPHIN_TERMINAL_ATTACHMENT_MAX_BYTES", "4")
    monkeypatch.setenv("DOLPHIN_TERMINAL_ATTACHMENT_MAX_STORAGE_BYTES", "16")

    async def chunks():
        yield b"12"
        yield b"34"

    stored = await service.store_terminal_attachment_stream(
        project_id="project-alpha",
        original_name="archive.bin",
        content_type="application/octet-stream",
        chunks=chunks(),
        content_length=4,
    )

    path = Path(stored.path)
    assert path.read_bytes() == b"1234"
    assert stored.size_bytes == 4
    assert path.stat().st_mode & 0o777 == 0o600
    assert not list(path.parent.glob(".*.tmp"))


@pytest.mark.asyncio
async def test_stream_store_rejects_actual_overflow_and_removes_temp_file(
    tmp_path,
    monkeypatch,
):
    service = _service()
    root = tmp_path / "terminal-attachments"
    monkeypatch.setenv("DOLPHIN_TERMINAL_ATTACHMENT_ROOT", str(root))
    monkeypatch.setenv("DOLPHIN_TERMINAL_ATTACHMENT_MAX_BYTES", "4")
    monkeypatch.setenv("DOLPHIN_TERMINAL_ATTACHMENT_MAX_STORAGE_BYTES", "16")

    async def chunks():
        yield b"123"
        yield b"45"

    with pytest.raises(service.TerminalAttachmentError) as exc_info:
        await service.store_terminal_attachment_stream(
            project_id="project-alpha",
            original_name="archive.bin",
            content_type="application/octet-stream",
            chunks=chunks(),
            content_length=1,
        )

    assert exc_info.value.status_code == 413
    if root.exists():
        assert not list(root.rglob("*.bin"))
        assert not list(root.rglob(".*.tmp"))


@pytest.mark.asyncio
async def test_stream_store_sanitizes_image_from_staged_file(
    tmp_path,
    monkeypatch,
):
    service = _service()
    root = tmp_path / "terminal-attachments"
    payload = _png_bytes(metadata=True)
    monkeypatch.setenv("DOLPHIN_TERMINAL_ATTACHMENT_ROOT", str(root))
    monkeypatch.setenv(
        "DOLPHIN_TERMINAL_ATTACHMENT_MAX_BYTES",
        str(len(payload) + 1024),
    )
    monkeypatch.setenv(
        "DOLPHIN_TERMINAL_ATTACHMENT_MAX_STORAGE_BYTES",
        str(len(payload) * 4),
    )

    async def chunks():
        midpoint = len(payload) // 2
        yield payload[:midpoint]
        yield payload[midpoint:]

    stored = await service.store_terminal_attachment_stream(
        project_id="project-alpha",
        original_name="capture.png",
        content_type="application/octet-stream",
        chunks=chunks(),
        content_length=len(payload),
    )

    path = Path(stored.path)
    assert stored.kind == "image"
    assert stored.content_type == "image/png"
    with Image.open(path, formats=["PNG"]) as sanitized:
        sanitized.load()
        assert sanitized.size == (3, 2)
        assert "Comment" not in sanitized.info
    assert not list(path.parent.glob(".*.tmp"))


@pytest.mark.asyncio
async def test_stream_store_cancellation_removes_only_its_temp_file(
    tmp_path,
    monkeypatch,
):
    service = _service()
    root = tmp_path / "terminal-attachments"
    monkeypatch.setenv("DOLPHIN_TERMINAL_ATTACHMENT_ROOT", str(root))
    monkeypatch.setenv("DOLPHIN_TERMINAL_ATTACHMENT_MAX_BYTES", "16")
    monkeypatch.setenv("DOLPHIN_TERMINAL_ATTACHMENT_MAX_STORAGE_BYTES", "32")

    async def chunks():
        yield b"partial"
        raise asyncio.CancelledError

    with pytest.raises(asyncio.CancelledError):
        await service.store_terminal_attachment_stream(
            project_id="project-alpha",
            original_name="cancelled.bin",
            content_type="application/octet-stream",
            chunks=chunks(),
            content_length=10,
        )

    if root.exists():
        assert not list(root.rglob("*.bin"))
        assert not list(root.rglob(".*.tmp"))


@pytest.mark.asyncio
async def test_stream_store_rejects_declared_upload_when_quota_cannot_fit_it(
    tmp_path,
    monkeypatch,
):
    service = _service()
    root = tmp_path / "terminal-attachments"
    monkeypatch.setenv("DOLPHIN_TERMINAL_ATTACHMENT_ROOT", str(root))
    monkeypatch.setenv("DOLPHIN_TERMINAL_ATTACHMENT_MAX_BYTES", "8")
    monkeypatch.setenv("DOLPHIN_TERMINAL_ATTACHMENT_MAX_STORAGE_BYTES", "8")

    await service.store_terminal_attachment(
        project_id="project-alpha",
        original_name="existing.bin",
        content_type="application/octet-stream",
        data=b"123456",
    )

    async def chunks():
        yield b"789"

    with pytest.raises(service.TerminalAttachmentError) as exc_info:
        await service.store_terminal_attachment_stream(
            project_id="project-alpha",
            original_name="over-quota.bin",
            content_type="application/octet-stream",
            chunks=chunks(),
            content_length=3,
        )

    assert exc_info.value.status_code == 507
    assert len(list(root.rglob("*.bin"))) == 1
    assert not list(root.rglob(".*.tmp"))


@pytest.mark.asyncio
async def test_startup_runs_cleanup_and_schedules_both_maintenance_loops(
    monkeypatch,
):
    main = importlib.import_module("app.main")
    events: list[str] = []
    scheduled_coroutines = []

    class _SessionContext:
        async def __aenter__(self):
            return object()

        async def __aexit__(self, *_args):
            return None

    async def init_db():
        events.append("db")

    async def seed_projects(_session):
        events.append("seed")

    async def link_inbox(_session):
        events.append("inbox")

    async def reconcile(_session):
        events.append("workspace-cleanup")

    async def prune_once():
        events.append("attachment-cleanup")

    def create_task(coroutine):
        scheduled_coroutines.append(coroutine)
        return SimpleNamespace(cancel=lambda: None)

    monkeypatch.setattr(main, "init_db", init_db)
    monkeypatch.setattr(main, "async_session", _SessionContext)
    monkeypatch.setattr(main, "seed_projects", seed_projects)
    monkeypatch.setattr(main, "link_inbox", link_inbox)
    monkeypatch.setattr(main, "reconcile_temporary_workspace_cleanup", reconcile)
    monkeypatch.setattr(main, "_prune_terminal_attachments_once", prune_once)
    monkeypatch.setattr(main.asyncio, "create_task", create_task)
    # Startup has grown steps this test is not about: the backup, migrations,
    # agent-run recovery and the fleet.
    # Stub them so it runs against nothing real and counts only its own loops.

    async def nothing(*_args, **_kwargs):
        return None

    import app.dolphin_agent as dolphin_agent

    monkeypatch.setattr(main.backup, "snapshot", lambda: None)
    monkeypatch.setattr(main.migrations, "upgrade", lambda: None)
    monkeypatch.setattr(dolphin_agent, "recover_agent_runs", nothing)
    if main.fleet_runtime is not None:  # an optional feature, absent from the public build
        monkeypatch.setattr(main.fleet_runtime, "start", nothing)
    monkeypatch.setattr(main.turn_notification_collector, "start", lambda: None)

    try:
        await main.startup()
    finally:
        for coroutine in scheduled_coroutines:
            coroutine.close()
        main._managed_workspace_cleanup_task = None
        main._terminal_attachment_cleanup_task = None

    assert events == [
        "db",
        "seed",
        "inbox",
        "workspace-cleanup",
        "attachment-cleanup",
    ]
    assert len(scheduled_coroutines) == 2


@pytest.mark.asyncio
async def test_periodic_cleanup_uses_the_configured_interval(monkeypatch):
    main = importlib.import_module("app.main")
    sleeps: list[int] = []
    cleanup_calls: list[str] = []

    async def sleep(seconds):
        sleeps.append(seconds)
        if len(sleeps) > 1:
            raise asyncio.CancelledError

    async def prune_once():
        cleanup_calls.append("pruned")

    monkeypatch.setattr(
        main,
        "terminal_attachment_settings",
        lambda: SimpleNamespace(cleanup_interval_seconds=37),
    )
    monkeypatch.setattr(main.asyncio, "sleep", sleep)
    monkeypatch.setattr(main, "_prune_terminal_attachments_once", prune_once)

    with pytest.raises(asyncio.CancelledError):
        await main._terminal_attachment_cleanup_loop()

    assert sleeps == [37, 37]
    assert cleanup_calls == ["pruned"]


class _FakeAttachmentRequest:
    def __init__(
        self,
        chunks: list[bytes],
        *,
        original_name: str = "brief \u03b1.pdf",
        content_type: str = "application/pdf",
        upload_header: str = "1",
        content_length: str | None = None,
    ):
        self._chunks = chunks
        self.headers = {
            "content-type": content_type,
            "x-dolphin-attachment-upload": upload_header,
            "x-dolphin-attachment-name": quote(original_name, safe=""),
        }
        if content_length is not None:
            self.headers["content-length"] = content_length

    async def stream(self):
        for chunk in self._chunks:
            yield chunk


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("is_codex_running", "is_claude_code_running"),
    [(True, False), (False, True)],
)
async def test_generic_route_is_exact_session_bound_and_decodes_the_filename(
    tmp_path,
    monkeypatch,
    is_codex_running,
    is_claude_code_running,
):
    main = importlib.import_module("app.main")
    service = _service()
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    session_calls: list[tuple[str, str]] = []

    async def workspace_for_project(project_id, _db):
        assert project_id == "project-alpha"
        return SimpleNamespace(id=project_id), workspace

    async def require_session(workspace_path, session_name):
        session_calls.append((str(workspace_path), session_name))
        return SimpleNamespace(
            name=session_name,
            is_codex_running=is_codex_running,
            is_claude_code_running=is_claude_code_running,
            observation_degraded=False,
        )

    async def store_attachment_stream(
        *,
        project_id,
        original_name,
        content_type,
        chunks,
        content_length,
    ):
        assert project_id == "project-alpha"
        assert original_name == "brief \u03b1.pdf"
        assert content_type == "application/pdf"
        assert b"".join([chunk async for chunk in chunks]) == b"%PDF data"
        assert content_length == 9
        return service.StoredTerminalAttachment(
            attachment_id="attachment-1",
            path="/safe/attachment-1.pdf",
            original_name=original_name,
            kind="file",
            content_type="application/pdf",
            width=None,
            height=None,
            size_bytes=9,
            created_at=service.utc_now(),
            expires_at=service.utc_now(),
        )

    monkeypatch.setattr(main, "_workspace_path_for_project", workspace_for_project)
    monkeypatch.setattr(main, "require_workspace_session", require_session)
    monkeypatch.setattr(
        main,
        "store_terminal_attachment_stream",
        store_attachment_stream,
    )
    monkeypatch.setenv("DOLPHIN_TERMINAL_ATTACHMENT_MAX_BYTES", "1024")

    response = await main.create_project_tmux_attachment(
        "project-alpha",
        "dolphin-alpha",
        _FakeAttachmentRequest([b"%PDF", b" data"], content_length="9"),
        db=object(),
    )

    assert session_calls == [(str(workspace), "dolphin-alpha")]
    assert response.original_name == "brief \u03b1.pdf"
    assert response.kind == "file"
    assert response.path == "/safe/attachment-1.pdf"


@pytest.mark.asyncio
async def test_generic_route_rejects_a_missing_header_and_an_overflow(
    tmp_path,
    monkeypatch,
):
    main = importlib.import_module("app.main")
    workspace = tmp_path / "workspace"
    workspace.mkdir()

    async def workspace_for_project(_project_id, _db):
        return SimpleNamespace(id="project-alpha"), workspace

    async def non_codex(_workspace_path, session_name):
        return SimpleNamespace(
            name=session_name,
            is_codex_running=False,
            is_claude_code_running=False,
            observation_degraded=False,
        )

    monkeypatch.setattr(main, "_workspace_path_for_project", workspace_for_project)
    monkeypatch.setattr(main, "require_workspace_session", non_codex)

    with pytest.raises(HTTPException) as missing_header:
        await main.create_project_tmux_attachment(
            "project-alpha",
            "dolphin-alpha",
            _FakeAttachmentRequest([b"x"], upload_header=""),
            db=object(),
        )
    assert missing_header.value.status_code == 400

    monkeypatch.setenv("DOLPHIN_TERMINAL_ATTACHMENT_ROOT", str(tmp_path / "store"))
    accepted = await main.create_project_tmux_attachment(
        "project-alpha",
        "dolphin-alpha",
        _FakeAttachmentRequest([b"x"]),
        db=object(),
    )
    assert accepted.kind == "file"
    assert accepted.path.endswith(".pdf")

    async def codex(_workspace_path, session_name):
        return SimpleNamespace(
            name=session_name,
            is_codex_running=True,
            is_claude_code_running=False,
            observation_degraded=False,
        )

    monkeypatch.setattr(main, "require_workspace_session", codex)
    monkeypatch.setenv("DOLPHIN_TERMINAL_ATTACHMENT_MAX_BYTES", "4")
    with pytest.raises(HTTPException) as overflow:
        await main.create_project_tmux_attachment(
            "project-alpha",
            "dolphin-alpha",
            _FakeAttachmentRequest([b"123", b"45"]),
            db=object(),
        )
    assert overflow.value.status_code == 413


@pytest.mark.asyncio
async def test_a_session_outside_the_workspace_is_refused(tmp_path, monkeypatch):
    main = importlib.import_module("app.main")
    workspace = tmp_path / "workspace"
    workspace.mkdir()

    async def workspace_for_project(_project_id, _db):
        return SimpleNamespace(id="project-alpha"), workspace

    async def foreign_session(_workspace_path, _session_name):
        raise main.TmuxServiceError(
            "That tmux session does not belong to this project.", 409
        )

    monkeypatch.setattr(main, "_workspace_path_for_project", workspace_for_project)
    monkeypatch.setattr(main, "require_workspace_session", foreign_session)

    with pytest.raises(HTTPException) as refused:
        await main.create_project_tmux_attachment(
            "project-alpha", "dolphin-alpha",
            _FakeAttachmentRequest([b"x"]), db=object(),
        )
    assert refused.value.status_code == 409


def test_only_the_generic_attachment_route_is_registered():
    main = importlib.import_module("app.main")
    routes = {
        route.path: route
        for route in main.app.routes
        if isinstance(route, APIRoute)
    }
    generic_path = (
        "/api/projects/{project_id}/tmux/sessions/{session_name}/attachments"
    )
    legacy_path = (
        "/api/projects/{project_id}/tmux/sessions/{session_name}/image-attachments"
    )

    assert routes[generic_path].methods == {"POST"}
    assert routes[generic_path].status_code == 201
    assert legacy_path not in routes


@pytest.mark.asyncio
async def test_a_plain_shell_session_accepts_an_attachment(tmp_path, monkeypatch):
    main = importlib.import_module("app.main")
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    monkeypatch.setenv("DOLPHIN_TERMINAL_ATTACHMENT_ROOT", str(tmp_path / "store"))

    async def workspace_for_project(_project_id, _db):
        return SimpleNamespace(id="project-alpha"), workspace

    async def plain_shell(_workspace_path, session_name):
        return SimpleNamespace(
            name=session_name,
            is_codex_running=False,
            is_claude_code_running=False,
            observation_degraded=True,
        )

    monkeypatch.setattr(main, "_workspace_path_for_project", workspace_for_project)
    monkeypatch.setattr(main, "require_workspace_session", plain_shell)

    response = await main.create_project_tmux_attachment(
        "project-alpha",
        "dolphin-alpha",
        _FakeAttachmentRequest([b"%PDF-1.4 minimal"]),
        db=object(),
    )

    assert response.kind == "file"
    assert response.path.endswith(".pdf")
    assert Path(response.path).is_file()
    assert Path(response.path).is_relative_to(tmp_path / "store")


@pytest.mark.asyncio
async def test_an_office_document_is_stored_as_an_opaque_file(tmp_path, monkeypatch):
    monkeypatch.setenv("DOLPHIN_TERMINAL_ATTACHMENT_ROOT", str(tmp_path / "store"))
    service = _service()

    buffer = BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("[Content_Types].xml", "<Types/>")
        archive.writestr("ppt/presentation.xml", "<p:presentation/>")
    deck = buffer.getvalue()

    async def chunks():
        yield deck

    stored = await service.store_terminal_attachment_stream(
        project_id="project-alpha",
        original_name="quarterly review.pptx",
        content_type=(
            "application/vnd.openxmlformats-officedocument"
            ".presentationml.presentation"
        ),
        chunks=chunks(),
        content_length=len(deck),
    )

    assert stored.kind == "file"
    assert stored.path.endswith(".pptx")
    assert stored.width is None and stored.height is None
    assert Path(stored.path).read_bytes() == deck
