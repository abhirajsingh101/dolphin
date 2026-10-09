"""Dolphin Desktop's helper mode: lifecycle, token gate, tmux override, native System Health."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]


def _helper(home: Path, *args: str, check: bool = False) -> subprocess.CompletedProcess:
    env = {k: v for k, v in os.environ.items() if not k.startswith("DOLPHIN_") and k != "DATABASE_URL"}
    env["DOLPHIN_HOME"] = str(home)
    env["DOLPHIN_GBRAIN"] = "off"  # memory setup downloads ~400 MB; tests/test_brain.py covers it
    return subprocess.run([sys.executable, "-m", "app.helper", *args], cwd=BACKEND, env=env,
                          capture_output=True, text=True, timeout=60, check=check)


def _wait_server(home: Path) -> dict:
    for _ in range(150):
        try:
            info = json.loads((home / "run" / "server.json").read_text())
            urllib.request.urlopen(f"http://127.0.0.1:{info['port']}/health", timeout=1)
            return info
        except Exception:
            time.sleep(0.2)
    raise AssertionError("helper never became healthy: " + (home / "logs" / "helper.log").read_text()[-2000:])


def _get(info: dict, path: str, token: str | None = None) -> tuple[int, object]:
    request = urllib.request.Request(f"http://127.0.0.1:{info['port']}{path}",
                                     headers={"X-Dolphin-Token": token} if token else {})
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as error:
        return error.code, None


def test_helper_serves_with_a_token_starts_once_and_stops(tmp_path):
    home = tmp_path / "home"
    try:
        _helper(home, "serve", "--port", "0", "--detach", check=True)
        info = _wait_server(home)
        token = (home / "token").read_text().strip()
        assert oct((home / "token").stat().st_mode & 0o777) == "0o600"
        assert oct(home.stat().st_mode & 0o777) == "0o700"

        assert _get(info, "/api/projects")[0] == 401
        status, projects = _get(info, "/api/projects", token)
        assert status == 200 and [p["name"] for p in projects] == ["Inbox"]
        assert _get(info, f"/api/projects?token={token}")[0] == 200
        assert _get(info, "/api/projects", "wrong-token")[0] == 401

        again = _helper(home, "serve", "--port", "0")
        assert json.loads(again.stdout)["pid"] == info["pid"]
        assert _helper(home, "status").returncode == 0
    finally:
        _helper(home, "stop")
    assert _helper(home, "status").returncode == 3
    assert not (home / "run" / "server.json").exists()


def test_helper_socket_is_private(tmp_path):
    home = tmp_path / "h"
    try:
        _helper(home, "serve", "--detach", check=True)
        for _ in range(150):
            server = home / "run" / "server.json"
            if server.exists():
                break
            time.sleep(0.2)
        socket_path = Path(json.loads(server.read_text())["socket"])
        for _ in range(100):
            if socket_path.exists():
                break
            time.sleep(0.1)
        assert oct(socket_path.stat().st_mode & 0o777) == "0o600"
        result = subprocess.run(["curl", "-s", "--unix-socket", str(socket_path), "http://x/health"],
                                capture_output=True, text=True, timeout=10)
        assert '"ok"' in result.stdout
    finally:
        _helper(home, "stop")


@pytest.mark.asyncio
async def test_token_gate_is_off_without_a_token_and_lets_preflight_and_health_through():
    from app.main import TokenGateMiddleware

    calls = []

    async def inner(scope, receive, send):
        calls.append(scope["path"])
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})

    sent = []

    async def send(message):
        sent.append(message)

    def scope(path, method="GET", headers=()):
        return {"type": "http", "path": path, "method": method, "headers": list(headers), "query_string": b""}

    await TokenGateMiddleware(inner, token="")(scope("/api/projects"), None, send)
    gate = TokenGateMiddleware(inner, token="s3cret")
    await gate(scope("/health"), None, send)
    await gate(scope("/api/projects", method="OPTIONS"), None, send)
    await gate(scope("/api/projects"), None, send)
    assert calls == ["/api/projects", "/health", "/api/projects"]
    assert sent[-2]["status"] == 401

    closed = []

    async def ws_send(message):
        closed.append(message)

    await gate({"type": "websocket", "path": "/stream", "headers": [], "query_string": b"token=nope"}, None, ws_send)
    assert closed == [{"type": "websocket.close", "code": 4401}]


def test_tmux_binary_override(monkeypatch, tmp_path):
    from app import tmux_service

    fake = tmp_path / "tmux"
    fake.write_text("#!/bin/sh\n")
    monkeypatch.setenv("DOLPHIN_TMUX_BIN", str(fake))
    assert tmux_service.tmux_binary() == str(fake)


@pytest.mark.asyncio
async def test_native_system_health_has_the_netdata_shape():
    from app.native_health import NativeHealth
    from app.system_health_service import SystemHealthService

    service = SystemHealthService(base_url="http://127.0.0.1:9", source="auto")
    summary = await service.summary(refresh=True)
    assert summary["available"] and summary["source"].startswith("system")
    assert summary["memory"]["total_bytes"] > 0 and summary["host"]["cpu_cores"] > 0
    assert {"usage_percent", "load1"} <= set(summary["cpu"])
    assert summary["filesystems"] and {"mount", "total_bytes", "usage_percent"} <= set(summary["filesystems"][0])

    native = NativeHealth()
    native.sample()
    native.sample()
    history = native.history("network", 3600, 120)
    assert history["unit"] == "B/s" and [s["name"] for s in history["series"]] == ["Received", "Sent"]
    assert len(history["series"][0]["points"]) == 2
    assert set(native.alerts()["counts"]) == {"warning", "critical"}
    processes = native.top_processes(5)
    assert processes and {"pid", "name", "cpu_percent", "memory_bytes"} <= set(processes[0])

    workloads = await service.workloads(refresh=True)
    assert workloads["available"] and workloads["processes"]
    assert (await service.alerts(refresh=True))["available"]


@pytest.mark.asyncio
async def test_netdata_mode_is_unchanged_when_netdata_is_down():
    from app.system_health_service import SystemHealthService

    summary = await SystemHealthService(base_url="http://127.0.0.1:9", source="netdata").summary(refresh=True)
    assert summary["available"] is False and summary["source"] == "netdata"


def test_bundled_tmux_is_used_only_when_needed(monkeypatch, tmp_path):
    from app import helper

    fake = tmp_path / "bundle" / "tmux" / "tmux"
    fake.parent.mkdir(parents=True)
    fake.write_text("#!/bin/sh\necho 'tmux 3.7c'\n")
    fake.chmod(0o755)
    monkeypatch.setenv("DOLPHIN_BUNDLED_TMUX", str(fake))
    # configure_tmux sets DOLPHIN_TMUX_BIN and edits PATH in place. setenv first
    # so monkeypatch records them and the fake tmux never leaks into later
    # tests (delenv of an unset variable records nothing to restore).
    monkeypatch.setenv("DOLPHIN_TMUX_BIN", "")
    monkeypatch.delenv("DOLPHIN_TMUX_BIN")
    monkeypatch.setenv("PATH", os.environ["PATH"])

    monkeypatch.delenv("DOLPHIN_FORCE_BUNDLED_TMUX", raising=False)
    monkeypatch.setattr("shutil.which", lambda name: "/usr/bin/tmux")
    monkeypatch.setattr(helper, "_tmux_version_ok", lambda binary: True)
    assert helper.configure_tmux(tmp_path / "home") is None  # a good system tmux wins

    monkeypatch.setattr(helper, "_tmux_version_ok", lambda binary: False)  # too old
    wrapper = helper.configure_tmux(tmp_path / "home")
    assert wrapper == str(tmp_path / "home" / "bin" / "tmux")
    text = (tmp_path / "home" / "bin" / "tmux").read_text()
    assert f'exec "{fake}" -L dolphin "$@"' in text and "TERMINFO_DIRS" in text
    assert os.environ["DOLPHIN_TMUX_BIN"] == wrapper
    assert os.environ["PATH"].startswith(str(tmp_path / "home" / "bin"))


def test_tmux_version_check_reads_the_version(tmp_path):
    from app.helper import _tmux_version_ok

    for version, ok in (("tmux 3.4", True), ("tmux 2.6", False), ("tmux next-3.6", True), ("nonsense", False)):
        binary = tmp_path / f"tmux-{abs(hash(version))}"
        binary.write_text(f"#!/bin/sh\necho '{version}'\n")
        binary.chmod(0o755)
        assert _tmux_version_ok(str(binary)) is ok, version


def test_helper_ignores_the_tmux_pane_it_was_started_from(monkeypatch, tmp_path):
    from app import helper

    # A copy, so the defaults it sets stay out of every later test.
    environ = {**os.environ, "TMUX": "/tmp/tmux-1/default,1,0", "TMUX_PANE": "%1"}
    monkeypatch.setattr(os, "environ", environ)
    helper.configure_environment(tmp_path, "t" * 40)
    assert "TMUX" not in environ and "TMUX_PANE" not in environ


def test_helper_and_desktop_app_share_one_version():
    from app.version import VERSION

    package = json.loads((Path(__file__).resolve().parents[2] / "dolphin-desktop" / "package.json").read_text())
    assert package["version"] == VERSION


def test_native_cpu_card_reports_the_samplers_reading(monkeypatch):
    # cpu_percent(None) measures since its previous call by anyone. The card
    # once called it right after the sampler and showed 0% on a busy machine.
    import psutil

    from app.native_health import NativeHealth

    native = NativeHealth()
    monkeypatch.setattr(psutil, "cpu_percent", lambda interval=None: 73.0)
    native.sample()
    native.sample()
    monkeypatch.setattr(psutil, "cpu_percent", lambda interval=None: 0.0)
    assert native.summary([], "cpu", "os")["cpu"]["usage_percent"] == 73.0


@pytest.mark.asyncio
async def test_self_client_reaches_the_helper_through_its_socket(tmp_path, monkeypatch):
    # The chat agent's tools call the backend's own API. In Dolphin Desktop that
    # is the helper's socket and token, never the web install's :8400.
    from app.self_api import self_client

    home = tmp_path / "h"
    try:
        _helper(home, "serve", "--detach", check=True)
        for _ in range(150):
            if (home / "run" / "server.json").exists():
                break
            time.sleep(0.2)
        info = json.loads((home / "run" / "server.json").read_text())
        monkeypatch.setenv("DOLPHIN_SELF_SOCKET", info["socket"])
        monkeypatch.setenv("DOLPHIN_TOKEN", (home / "token").read_text().strip())
        for _ in range(150):
            try:
                async with self_client(timeout=5) as api:
                    response = await api.get("/api/projects")
                break
            except Exception:
                time.sleep(0.2)
        assert response.status_code == 200 and [p["name"] for p in response.json()] == ["Inbox"]
    finally:
        _helper(home, "stop")
