"""How Dolphin attaches its tmux client, by tmux version.

tmux only passes true colour, OSC 52, OSC 8, focus events and extended keys
to a client that declares them with -T (tmux 3.2+; "hyperlinks" is 3.4+).
The desktop helper accepts a host tmux as old as 3.0, where -T and attach -f
do not exist and would make attach fail outright, so the flags are gated.
"""

import asyncio

import pytest

from app import tmux_service
from app.terminal_attach import (
    DOLPHIN_TITLE_FORMAT,
    installed_tmux_version,
    parse_tmux_version,
    tmux_attach_command,
    tmux_attach_env,
)


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("tmux 3.4\n", (3, 4)),
        ("tmux 3.3a", (3, 3)),
        ("tmux 3.0a", (3, 0)),
        ("tmux next-3.6", (3, 6)),
        ("tmux 3.7c", (3, 7)),
        ("tmux master", (99, 0)),
        ("tmux 2.9", (2, 9)),
        ("tmux next-3.5", (3, 5)),
        ("openbsd-7.4", (7, 4)),
        ("", (0, 0)),
        ("not tmux", (0, 0)),
    ],
)
def test_parse_tmux_version(text, expected):
    assert parse_tmux_version(text) == expected


def test_new_tmux_gets_every_terminal_feature():
    assert tmux_attach_command("/usr/bin/tmux", "work", (3, 4)) == [
        "/usr/bin/tmux", "-T", "RGB,clipboard,hyperlinks,focus,extkeys",
        "attach-session", "-t", "work",
    ]


def test_tmux_3_2_and_3_3_get_features_without_hyperlinks():
    for version in ((3, 2), (3, 3)):
        assert tmux_attach_command("tmux", "work", version) == [
            "tmux", "-T", "RGB,clipboard,focus,extkeys", "attach-session", "-t", "work",
        ]


def test_tmux_older_than_3_2_attaches_plainly():
    # Review Focus 2: -T does not exist before 3.2 and would fail the attach.
    for version in ((3, 0), (3, 1), (0, 0)):
        assert tmux_attach_command("tmux", "work", version) == ["tmux", "attach-session", "-t", "work"]


def test_previews_neither_resize_nor_type():
    assert tmux_attach_command("tmux", "work", (3, 4), preview=True) == [
        "tmux", "-T", "RGB,clipboard,hyperlinks,focus,extkeys",
        "attach-session", "-t", "work", "-f", "ignore-size,read-only",
    ]


def test_previews_on_old_tmux_are_still_read_only():
    # Review Focus 2: attach -f is 3.2+; -r (read-only) has always existed.
    assert tmux_attach_command("tmux", "work", (3, 1), preview=True) == [
        "tmux", "attach-session", "-t", "work", "-r",
    ]


def test_attach_env_declares_true_colour_without_mutating_its_input():
    base = {"PATH": "/bin", "TERM": "dumb"}
    env = tmux_attach_env(base)
    assert env["TERM"] == "xterm-256color"
    assert env["COLORTERM"] == "truecolor"
    assert env["PATH"] == "/bin"
    assert base == {"PATH": "/bin", "TERM": "dumb"}


@pytest.mark.asyncio
async def test_an_unrunnable_tmux_reads_as_unknown(tmp_path):
    assert await installed_tmux_version(str(tmp_path / "missing-tmux")) == (0, 0)


@pytest.mark.asyncio
async def test_the_version_is_read_once_per_binary(tmp_path):
    script = tmp_path / "tmux"
    counter = tmp_path / "calls"
    script.write_text(f"#!/bin/sh\necho x >> {counter}\necho 'tmux 3.3a'\n")
    script.chmod(0o755)
    assert await installed_tmux_version(str(script)) == (3, 3)
    assert await installed_tmux_version(str(script)) == (3, 3)
    assert counter.read_text().count("x") == 1


@pytest.mark.asyncio
async def test_sessions_dolphin_creates_forward_the_pane_title(monkeypatch, tmp_path):
    """tmux sends the outer terminal a title only with set-titles on. Dolphin
    turns it on for sessions it creates, never for the user's own sessions.
    The format is empty while the pane title is still tmux's default, the
    host name, so the tab does not read "myhost · build"."""
    monkeypatch.setenv("TMUX_TMPDIR", str(tmp_path))
    spawned: list[tuple[str, ...]] = []

    async def no_sessions():
        return []

    async def gone(*_args):
        raise tmux_service.TmuxServiceError("gone", 404)

    async def record_spawn(*args: str):
        spawned.append(args)

        async def exited() -> int:
            return 1

        return asyncio.create_task(exited())

    monkeypatch.setattr(tmux_service, "list_all_sessions", no_sessions)
    monkeypatch.setattr(tmux_service, "require_workspace_session", gone)
    monkeypatch.setattr(tmux_service, "_spawn_tmux_detached", record_spawn)

    with pytest.raises(tmux_service.TmuxServiceError):
        await tmux_service.create_session(tmp_path, "Atlas", "build")

    args = list(spawned[0])
    name = args[args.index("-s") + 1]
    assert args[args.index(";"):] == [
        ";", "set-option", "-t", name, "set-titles", "on",
        ";", "set-option", "-t", name, "set-titles-string", DOLPHIN_TITLE_FORMAT,
    ]
    assert DOLPHIN_TITLE_FORMAT == "#{?#{==:#{pane_title},#{host}},,#{pane_title}}"


def _fake_tmux(path, version, sleep=0):
    path.write_text(f"#!/bin/sh\nsleep {sleep}\necho 'tmux {version}'\n")
    path.chmod(0o755)


@pytest.mark.asyncio
async def test_a_replaced_binary_is_probed_again(tmp_path):
    script = tmp_path / "tmux"
    _fake_tmux(script, "3.1")
    assert await installed_tmux_version(str(script)) == (3, 1)
    _fake_tmux(script, "3.4a")  # different size and mtime
    assert await installed_tmux_version(str(script)) == (3, 4)


@pytest.mark.asyncio
async def test_a_probe_that_times_out_is_not_cached(tmp_path, monkeypatch):
    from app import terminal_attach

    script = tmp_path / "tmux"
    _fake_tmux(script, "3.3", sleep=5)
    monkeypatch.setattr(terminal_attach, "PROBE_TIMEOUT", 0.3)
    assert await installed_tmux_version(str(script)) == (0, 0)
    _fake_tmux(script, "3.3")
    # same size, so only the failure not being cached lets this succeed
    script.write_text(script.read_text())
    assert await installed_tmux_version(str(script)) == (3, 3)


from app.terminal_attach import DEFAULT_PTY_SIZE, await_initial_size


def _receiver(*messages):
    queue: asyncio.Queue = asyncio.Queue()
    for message in messages:
        queue.put_nowait(message)

    async def receive():
        return await queue.get()

    return receive


def _text(payload: str) -> dict:
    return {"type": "websocket.receive", "text": payload}


@pytest.mark.asyncio
async def test_the_first_resize_sets_the_size():
    initial = await await_initial_size(_receiver(_text('{"type":"resize","cols":100,"rows":30}')))
    assert initial.size == (100, 30)
    assert initial.early_input == []
    assert initial.disconnected is False


@pytest.mark.asyncio
async def test_the_first_size_is_bounded_like_every_resize():
    initial = await await_initial_size(_receiver(_text('{"type":"resize","cols":9000,"rows":2}')))
    assert initial.size == (300, 8)


@pytest.mark.asyncio
async def test_keys_before_the_resize_are_kept_in_order():
    # Review Focus 1: nothing typed before the resize may be lost.
    initial = await await_initial_size(_receiver(
        _text('{"type":"input","data":"ab"}'),
        {"type": "websocket.receive", "bytes": b"c"},
        _text("not json"),
        _text('{"type":"input","data":"d"}'),
        _text('{"type":"resize","cols":90,"rows":25}'),
    ))
    assert initial.early_input == [b"ab", b"c", b"d"]
    assert initial.size == (90, 25)


@pytest.mark.asyncio
async def test_no_resize_falls_back_to_the_old_default_after_the_timeout():
    async def never():
        await asyncio.sleep(3600)

    initial = await await_initial_size(never, timeout=0.05)
    assert initial.size == DEFAULT_PTY_SIZE
    assert initial.disconnected is False


@pytest.mark.asyncio
async def test_a_disconnect_before_the_resize_is_reported():
    initial = await await_initial_size(_receiver({"type": "websocket.disconnect"}))
    assert initial.disconnected is True


@pytest.mark.asyncio
async def test_early_input_is_capped():
    from app.terminal_attach import MAX_EARLY_INPUT_BYTES

    chunk = "x" * 1024
    messages = [_text('{"type":"input","data":"%s"}' % chunk)] * 100
    initial = await await_initial_size(_receiver(*messages, _text('{"type":"resize","cols":90,"rows":25}')))
    assert sum(len(part) for part in initial.early_input) <= MAX_EARLY_INPUT_BYTES
    assert initial.size == (90, 25)
