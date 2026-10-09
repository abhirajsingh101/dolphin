"""An HTTP client for this backend's own API, wherever it is listening.

The web install listens on :8400 with no token. Dolphin Desktop's helper listens
on a private Unix socket (or a loopback port) and requires its token; it records
where in DOLPHIN_SELF_SOCKET / DOLPHIN_SELF_PORT before serving.
"""

from __future__ import annotations

import os

import httpx


def self_client(**kwargs) -> httpx.AsyncClient:
    socket = os.getenv("DOLPHIN_SELF_SOCKET")
    port = os.getenv("DOLPHIN_SELF_PORT") or os.getenv("DOLPHIN_BACKEND_PORT") or "8400"
    token = os.getenv("DOLPHIN_TOKEN")
    return httpx.AsyncClient(
        base_url="http://dolphin" if socket else f"http://127.0.0.1:{port}",
        transport=httpx.AsyncHTTPTransport(uds=socket) if socket else None,
        headers={"X-Dolphin-Token": token} if token else None,
        trust_env=False,
        **kwargs,
    )
