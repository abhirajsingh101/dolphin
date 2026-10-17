"""The host guard: DNS rebinding and cross-site requests, refused without a login.

A page that re-points its own name at 127.0.0.1 sends that name in Host; a
page on another site sends its own Origin. Neither may drive tmux.
"""

import pytest
from starlette.applications import Starlette
from starlette.responses import PlainTextResponse
from starlette.routing import Route, WebSocketRoute
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app import main
from app.main import HostGuardMiddleware, _host_name, _parse_allowed_hosts

CORS = [
    "http://127.0.0.1:8421",
    "http://localhost:8421",
    "https://box.tailnet.ts.net:8421",
    "http://[2001:db8::1]:8421",
]


async def _ok(request):
    return PlainTextResponse("ok")


async def _ws(websocket):
    await websocket.accept()
    await websocket.send_text("hi")
    await websocket.close()


def _client(extra_hosts: str = "", helper_mode: bool = False) -> TestClient:
    inner = Starlette(routes=[Route("/r", _ok, methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]),
                              WebSocketRoute("/ws", _ws)])
    guarded = HostGuardMiddleware(inner, cors_origins=CORS, extra_hosts=extra_hosts, helper_mode=helper_mode)
    return TestClient(guarded, base_url="http://127.0.0.1:8400")


@pytest.mark.parametrize("host", [
    "localhost", "localhost:8400", "127.0.0.1:8400", "127.0.0.1", "[::1]:8400", "[::1]",
    "LOCALHOST:8400", "box.tailnet.ts.net:8400", "box.tailnet.ts.net", "[2001:db8::1]:8400",
])
def test_allowed_hosts(host):
    assert _client().get("/r", headers={"host": host}).status_code == 200


@pytest.mark.parametrize("host", [
    "attacker.example:8400", "attacker.example", "127.0.0.1.attacker.example", "localhost.attacker.example:8400",
    "[::2]:8400", "box.tailnet.ts.net.evil:8400", "", "testserver", "dolphin",
])
def test_foreign_host_is_refused(host):
    response = _client().get("/r", headers={"host": host})
    assert response.status_code == 421
    assert response.headers["content-type"].startswith("text/plain")
    assert "DOLPHIN_ALLOWED_HOSTS" in response.text


def test_host_parsing():
    assert _host_name("Example.COM:8400") == "example.com"
    assert _host_name("[::1]:8400") == "::1"
    assert _host_name("[fd7a::1]") == "fd7a::1"
    assert _host_name("::1") == "::1"
    assert _host_name("localhost.") == "localhost"
    assert _parse_allowed_hosts("a.example, b.example:c.example [fd7a::1],[::2]") == {
        "a.example", "b.example", "c.example", "fd7a::1", "::2"}


def test_env_additions(monkeypatch):
    assert _client().get("/r", headers={"host": "proxy.example:443"}).status_code == 421
    client = _client(extra_hosts="proxy.example:[fd00::5]")
    assert client.get("/r", headers={"host": "proxy.example:443"}).status_code == 200
    assert client.get("/r", headers={"host": "[fd00::5]:8400"}).status_code == 200
    # Without explicit settings the guard reads DOLPHIN_ALLOWED_HOSTS.
    monkeypatch.setenv("DOLPHIN_ALLOWED_HOSTS", "env.example")
    guard = HostGuardMiddleware(None, cors_origins=[])
    assert "env.example" in guard.allowed_hosts and "localhost" in guard.allowed_hosts


async def _call(guard, scope):
    sent = []

    async def send(message):
        sent.append(message)

    await guard(scope, None, send)
    return sent


async def _app(scope, receive, send):
    await send({"type": "http.response.start", "status": 200, "headers": []})
    await send({"type": "http.response.body", "body": b"ok"})


@pytest.mark.asyncio
async def test_missing_host_is_refused():
    guard = HostGuardMiddleware(_app, cors_origins=CORS, extra_hosts="")
    sent = await _call(guard, {"type": "http", "method": "GET", "path": "/r", "headers": [],
                               "server": ("127.0.0.1", 8400)})
    assert sent[0]["status"] == 421


@pytest.mark.asyncio
async def test_unix_socket_host_only_on_a_unix_socket():
    """self_api and agent_hook send Host "dolphin" over the helper's socket."""
    guard = HostGuardMiddleware(_app, cors_origins=CORS, extra_hosts="", helper_mode=True)
    scope = {"type": "http", "method": "POST", "path": "/r", "headers": [(b"host", b"dolphin")]}
    assert (await _call(guard, {**scope, "server": None}))[0]["status"] == 200
    assert (await _call(guard, {**scope, "server": ("127.0.0.1", 8400)}))[0]["status"] == 421
    # The socket still refuses a rebound name (the desktop relay feeds it from loopback TCP).
    rebound = {**scope, "server": None, "headers": [(b"host", b"attacker.example:51234")]}
    assert (await _call(guard, rebound))[0]["status"] == 421


@pytest.mark.asyncio
async def test_lifespan_passes_through():
    seen = []

    async def inner(scope, receive, send):
        seen.append(scope["type"])

    await HostGuardMiddleware(inner, cors_origins=CORS, extra_hosts="")({"type": "lifespan"}, None, None)
    assert seen == ["lifespan"]


def _ws_headers(**headers):
    # TestClient's websocket_connect ignores base_url and sends Host "testserver".
    return {"host": "127.0.0.1:8400", **headers}


def test_websocket_with_foreign_host_is_refused_before_accept():
    with pytest.raises(WebSocketDisconnect) as refused:
        with _client().websocket_connect("/ws", headers={"host": "attacker.example:8400"}):
            pass
    assert refused.value.code == 1008


def test_websocket_origin_rules():
    client = _client()
    with client.websocket_connect("/ws", headers=_ws_headers(origin="http://127.0.0.1:8421")) as ws:
        assert ws.receive_text() == "hi"
    with client.websocket_connect("/ws", headers=_ws_headers()) as ws:  # no Origin: a CLI client
        assert ws.receive_text() == "hi"
    for origin in ("https://attacker.example", "null", "http://localhost:3000"):
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect("/ws", headers=_ws_headers(origin=origin)):
                pass


@pytest.mark.parametrize("method", ["POST", "PUT", "PATCH", "DELETE"])
def test_state_changing_requests_check_origin(method):
    client = _client()
    assert client.request(method, "/r").status_code == 200  # absent Origin: curl, scripts, hooks
    assert client.request(method, "/r", headers={"origin": "http://localhost:8421"}).status_code == 200
    assert client.request(method, "/r", headers={"origin": "HTTPS://Box.Tailnet.ts.net:8421"}).status_code == 200
    assert client.request(method, "/r", headers={"origin": "http://[2001:db8::1]:8421"}).status_code == 200
    for origin in ("https://attacker.example", "null", "http://localhost:3000", "https://box.tailnet.ts.net",
                   "garbage", "http://127.0.0.1:99999"):
        refused = client.request(method, "/r", headers={"origin": origin})
        assert refused.status_code == 403, origin
        assert refused.text == "Cross-origin request refused.\n"


def test_reads_do_not_check_origin():
    # A cross-site GET cannot read the answer (CORS); Host is still checked.
    assert _client().get("/r", headers={"origin": "https://attacker.example"}).status_code == 200


def test_same_origin_and_allowed_host_origins():
    client = _client(extra_hosts="proxy.example")
    assert client.post("/r", headers={"origin": "http://127.0.0.1:8400"}).status_code == 200  # its own page
    assert client.post("/r", headers={"host": "proxy.example", "origin": "https://proxy.example"}).status_code == 200
    assert client.post("/r", headers={"origin": "https://proxy.example:8443"}).status_code == 200


def test_desktop_origin_only_in_helper_mode():
    assert _client().post("/r", headers={"origin": "app://dolphin"}).status_code == 403
    helper = _client(helper_mode=True)
    assert helper.post("/r", headers={"origin": "app://dolphin"}).status_code == 200
    with helper.websocket_connect("/ws", headers=_ws_headers(origin="app://dolphin")) as ws:
        assert ws.receive_text() == "hi"
    # app://dolphin's "dolphin" is an origin, never a Host name over TCP.
    assert helper.get("/r", headers={"host": "dolphin"}).status_code == 421


def test_the_real_app_is_guarded():
    with TestClient(main.app) as client:
        assert client.get("/health").status_code == 200  # testserver, added by conftest
        assert client.get("/health", headers={"host": "attacker.example:8400"}).status_code == 421
        assert client.get("/health", headers={"host": "127.0.0.1:8400"}).status_code == 200
        refused = client.post("/api/projects", json={}, headers={"origin": "https://attacker.example"})
        assert refused.status_code == 403
