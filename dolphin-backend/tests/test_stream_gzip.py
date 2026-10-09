"""Server-sent events must bypass gzip, or the browser never sees them."""

import pytest

from app.main import StreamSafeGZipMiddleware


async def _run(accept: bytes):
    async def inner(scope, receive, send):
        await send({"type": "http.response.start", "status": 200,
                    "headers": [(b"content-type", b"text/event-stream")]})
        await send({"type": "http.response.body", "body": b": connected\n\n", "more_body": True})
        await send({"type": "http.response.body", "body": b"x" * 2000, "more_body": False})

    sent = []

    async def send(message):
        sent.append(message)

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    scope = {"type": "http", "method": "GET", "path": "/api/notifications/stream",
             "headers": [(b"accept", accept), (b"accept-encoding", b"gzip, deflate, br")]}
    await StreamSafeGZipMiddleware(inner, minimum_size=1_000)(scope, receive, send)
    return sent


@pytest.mark.asyncio
async def test_event_stream_is_never_gzipped_and_flushes_the_first_chunk():
    sent = await _run(b"text/event-stream")
    headers = dict(sent[0]["headers"])
    assert b"content-encoding" not in headers
    assert sent[1]["body"] == b": connected\n\n"


@pytest.mark.asyncio
async def test_other_responses_are_still_gzipped():
    sent = await _run(b"application/json")
    headers = dict(sent[0]["headers"])
    assert headers.get(b"content-encoding") == b"gzip"
