"""The terminal stream's two directions: output coalescing and input writing.

Output — measured motivation: xterm's renderer and React both pay per websocket
frame, and a redrawing agent TUI makes the PTY readable many times per rendered
frame. Merging chunks that are *already queued* removes that multiplier
without ever making the stream wait, so a keystroke echo is unaffected.

The property that matters and is easy to lose in a refactor: this must never
introduce a delay, and must never swallow the end-of-stream sentinel.

Input — the PTY master is non-blocking, so a single `os.write` accepts only
what fits in the tty's input buffer (11,776 bytes on this kernel) and reports
the rest back as a short write. Ignoring that return value truncated every
paste past that size, and a truncated *bracketed* paste loses its `\\x1b[201~`
terminator, which leaves Claude Code or Codex accumulating every later
keystroke as paste body — the terminal looks dead until the session is killed.
"""

import asyncio
import contextlib
import os
import pty
import tty

import pytest

from app.main import (
    _MAX_COALESCED_OUTPUT_BYTES,
    PtyOutputQueue,
    coalesce_pty_output,
    write_all_to_pty,
)


def _queue(*items: bytes | None) -> "asyncio.Queue[bytes | None]":
    queue: asyncio.Queue[bytes | None] = asyncio.Queue()
    for item in items:
        queue.put_nowait(item)
    return queue


def test_a_lone_chunk_is_returned_untouched():
    # The latency-critical case: one keystroke echo, nothing else queued.
    # It must go out exactly as it arrived, with no waiting and no copying.
    queue = _queue()
    assert coalesce_pty_output(queue, b"a") == b"a"
    assert queue.empty()


def test_queued_chunks_merge_in_arrival_order():
    queue = _queue(b"second", b"third")
    assert coalesce_pty_output(queue, b"first") == b"firstsecondthird"
    assert queue.empty()


def test_the_end_of_stream_sentinel_is_put_back_not_consumed():
    # Swallowing it would leave pty_to_websocket blocked on a queue that will
    # never receive anything again, so the socket would hang open.
    queue = _queue(b"tail", None)
    assert coalesce_pty_output(queue, b"head") == b"headtail"
    assert queue.get_nowait() is None


def test_merging_stops_at_a_sentinel_without_losing_anything_behind_it():
    # In the live stream the sentinel is always last: it is queued only once
    # the PTY reports EOF, after which nothing else is read. This asserts the
    # invariant that holds regardless of ordering — merging stops there, and
    # neither the sentinel nor any queued bytes are dropped.
    queue = _queue(None, b"queued behind the sentinel")

    assert coalesce_pty_output(queue, b"head") == b"head"

    remaining = [queue.get_nowait() for _ in range(queue.qsize())]
    assert b"queued behind the sentinel" in remaining
    assert None in remaining


def test_a_burst_is_capped_and_the_remainder_is_left_queued():
    # A cap bounds one frame; it must not drop the excess, which stays in the
    # queue and goes out in the next frame.
    chunk = b"x" * 64_000
    count = (_MAX_COALESCED_OUTPUT_BYTES // len(chunk)) + 3
    queue = _queue(*[chunk] * count)

    merged = coalesce_pty_output(queue, b"head")

    assert len(merged) <= _MAX_COALESCED_OUTPUT_BYTES + len(chunk)
    assert not queue.empty(), "the capped remainder must survive for the next frame"
    total = len(merged) + sum(len(queue.get_nowait()) for _ in range(queue.qsize()))
    assert total == len(b"head") + len(chunk) * count, "no byte may be dropped"


# --- the input direction: websocket -> PTY ---------------------------------


def _raw_pty() -> tuple[int, int]:
    """A PTY pair configured the way `tmux attach-session` leaves one: raw,
    with a non-blocking master. Raw mode matters — the line discipline would
    otherwise rewrite the bytes under test."""
    master_fd, slave_fd = pty.openpty()
    tty.setraw(master_fd)
    os.set_blocking(master_fd, False)
    return master_fd, slave_fd


async def _read_exactly(fd: int, expected: int) -> bytes:
    chunks: list[bytes] = []
    received = 0
    while received < expected:
        chunk = await asyncio.to_thread(os.read, fd, 65536)
        if not chunk:
            break
        chunks.append(chunk)
        received += len(chunk)
    return b"".join(chunks)


@pytest.mark.asyncio
async def test_a_paste_larger_than_the_tty_buffer_arrives_whole():
    # The reported bug: paste a long message into Claude Code or Codex over the
    # web terminal and the session wedges. 200KB is an ordinary paste — a stack
    # trace, a file, a chunk of a log — and roughly 17x what one os.write takes.
    master_fd, slave_fd = _raw_pty()
    payload = ("\x1b[200~" + "x" * 200_000 + "\x1b[201~").encode()

    try:
        reader = asyncio.create_task(_read_exactly(slave_fd, len(payload)))
        await write_all_to_pty(master_fd, payload)
        received = await asyncio.wait_for(reader, timeout=10)
    finally:
        os.close(slave_fd)
        os.close(master_fd)

    assert len(received) == len(payload), "a short write silently truncated the paste"
    assert received == payload, "bytes were dropped, duplicated, or reordered"
    assert received.endswith(b"\x1b[201~"), (
        "losing the bracketed-paste terminator is what wedges the TUI: "
        "every later keystroke is swallowed as paste body"
    )


@pytest.mark.asyncio
async def test_consecutive_writes_keep_their_order_across_a_stall():
    # Draining a long write must not let a later keystroke overtake it, or the
    # paste and the Enter that follows it arrive interleaved.
    master_fd, slave_fd = _raw_pty()
    first = b"a" * 120_000
    second = b"\r"

    try:
        reader = asyncio.create_task(_read_exactly(slave_fd, len(first) + 1))
        await write_all_to_pty(master_fd, first)
        await write_all_to_pty(master_fd, second)
        received = await asyncio.wait_for(reader, timeout=10)
    finally:
        os.close(slave_fd)
        os.close(master_fd)

    assert received == first + second


@pytest.mark.asyncio
async def test_writing_to_a_closed_pty_returns_instead_of_raising():
    # The client can disconnect mid-paste. That must end the write quietly,
    # exactly as the suppressed OSError used to, and never hang.
    master_fd, slave_fd = _raw_pty()
    os.close(slave_fd)
    os.close(master_fd)

    await asyncio.wait_for(write_all_to_pty(master_fd, b"x" * 100_000), timeout=5)


def test_the_output_queue_pauses_above_high_water_and_resumes_below_low_water():
    async def exercise():
        events: list[str] = []
        output = PtyOutputQueue(lambda: events.append("pause"), lambda: events.append("resume"), high=1000, low=300)
        for _ in range(5):
            output.put(b"x" * 300)
        assert events == ["pause"] and output.paused and output.size == 1500
        received = b""
        while output.size:
            received += await output.get()
        assert events == ["pause", "resume"] and not output.paused
        assert received == b"x" * 1500
        output.end()
        assert await output.get() is None

    asyncio.run(exercise())


def test_no_resume_after_the_stream_ended():
    async def exercise():
        events: list[str] = []
        output = PtyOutputQueue(lambda: events.append("pause"), lambda: events.append("resume"), high=10, low=5)
        output.put(b"0123456789AB")
        output.end()
        assert await output.get() == b"0123456789AB"
        assert events == ["pause"]
        assert await output.get() is None

    asyncio.run(exercise())


def _write_all_blocking(fd: int, data: bytes) -> None:
    view = memoryview(data)
    while view:
        view = view[os.write(fd, view):]


@pytest.mark.asyncio
async def test_a_slow_reader_pauses_the_pty_instead_of_growing_memory():
    master, slave = pty.openpty()
    tty.setraw(slave)
    os.set_blocking(master, False)
    loop = asyncio.get_running_loop()
    peak = 0
    high = 256 * 1024
    output: PtyOutputQueue

    def on_readable() -> None:
        nonlocal peak
        try:
            data = os.read(master, 65536)
        except BlockingIOError:
            return
        if not data:
            loop.remove_reader(master)
            output.end()
            return
        output.put(data)
        peak = max(peak, output.size)

    output = PtyOutputQueue(lambda: loop.remove_reader(master), lambda: loop.add_reader(master, on_readable), high=high, low=64 * 1024)
    loop.add_reader(master, on_readable)
    payload = bytes(range(256)) * 16384  # 4 MiB
    writer = asyncio.ensure_future(asyncio.to_thread(_write_all_blocking, slave, payload))
    try:
        await asyncio.sleep(1.0)  # nobody drains: the writer must be held back by the pty
        assert output.paused
        assert peak <= high + 65536
        assert not writer.done()
        received = bytearray()
        while len(received) < len(payload):
            received += await asyncio.wait_for(output.get(), 5)
        await asyncio.wait_for(writer, 5)
        assert bytes(received) == payload
    finally:
        with contextlib.suppress(ValueError):
            loop.remove_reader(master)
        os.close(master)
        os.close(slave)
