import pytest

from app import tmux_service


@pytest.mark.asyncio
async def test_a_snapshot_can_reach_back_ten_thousand_lines(monkeypatch, tmp_path):
    calls: list[tuple[str, ...]] = []

    async def found(*_args):
        return None

    async def fake_run(*args: str, check: bool = True):
        calls.append(args)
        return 0, "line\n", ""

    monkeypatch.setattr(tmux_service, "require_workspace_session", found)
    monkeypatch.setattr(tmux_service, "_run_tmux", fake_run)

    def start_of(args: tuple[str, ...]) -> str:
        return args[args.index("-S") + 1]

    await tmux_service.capture_session(tmp_path, "s", lines=10_000)
    assert start_of(calls[-1]) == "-10000"
    await tmux_service.capture_session(tmp_path, "s", lines=50_000)
    assert start_of(calls[-1]) == "-10000"
    await tmux_service.capture_session(tmp_path, "s", lines=1)
    assert start_of(calls[-1]) == "-40"
    assert tmux_service.MAX_SNAPSHOT_LINES == 10_000
