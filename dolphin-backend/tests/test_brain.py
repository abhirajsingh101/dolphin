"""Dolphin's memory: setting up a GBrain per machine, and calling it from the chat.

Nothing here downloads anything. A fake Bun stands in for the real one: it
"installs" GBrain, "creates" the brain and answers calls, the way the real
pieces do, so setup's steps, state and failures are all exercised.
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import time
import zipfile
from pathlib import Path

import httpx
import pytest

from app import brain

FAKE_BUN = r"""#!/bin/sh
# install: run in the runtime folder; it creates GBrain's CLI.
if [ "$1" = "install" ]; then
  mkdir -p node_modules/gbrain/src && echo "// cli" > node_modules/gbrain/src/cli.ts
  echo "178 packages installed"; exit 0
fi
shift  # the cli.ts path
case "$1" in
  init) mkdir -p "$GBRAIN_HOME/.gbrain" && touch "$GBRAIN_HOME/.gbrain/brain.pglite"
        echo '{"status":"success","engine":"pglite"}' ;;
  config) echo "$@" >> "$GBRAIN_HOME/config.log" ;;
  call) echo "gbrain 0.60 -> 0.61 available"   # a notice before the JSON, as the real one prints
        printf '{"tool":"%s","args":%s}\n' "$2" "$3" ;;
esac
"""


def _bun_zip(key: str) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr(f"bun-{key}/bun", FAKE_BUN)
    return buffer.getvalue()


@pytest.fixture
def dolphin_home(tmp_path, monkeypatch):
    monkeypatch.setenv("DOLPHIN_HOME", str(tmp_path / "dolphin"))
    monkeypatch.delenv("DOLPHIN_GBRAIN_COMMAND", raising=False)
    monkeypatch.setenv("DOLPHIN_GBRAIN", "auto")
    monkeypatch.setattr(brain, "_platform_key", lambda: "linux-x64")
    archive = _bun_zip("linux-x64")
    monkeypatch.setitem(brain.BUN_SHA256, "linux-x64", hashlib.sha256(archive).hexdigest())
    downloads: list[str] = []

    def download(url, target):
        downloads.append(url)
        Path(target).write_bytes(archive)

    monkeypatch.setattr(brain, "_download", download)
    monkeypatch.setattr(brain, "_worker", None)
    return downloads


def test_off_unless_asked_and_external_when_pointed_at_one(monkeypatch):
    monkeypatch.delenv("DOLPHIN_GBRAIN", raising=False)
    monkeypatch.delenv("DOLPHIN_GBRAIN_COMMAND", raising=False)
    assert brain.status() == {"state": "off"}
    monkeypatch.setenv("DOLPHIN_GBRAIN_COMMAND", "/opt/gbrain/bin/gbrain")
    assert brain.status()["state"] == "ready" and brain.status()["source"] == "external"


def test_setup_installs_bun_and_gbrain_creates_the_brain_and_checks_it(dolphin_home):
    assert brain.status()["state"] == "missing"
    brain.install()

    status = brain.status()
    assert status == {"state": "ready", "source": "dolphin", "version": brain.GBRAIN_VERSION, "keyless": True}
    assert dolphin_home == [f"https://github.com/oven-sh/bun/releases/download/bun-v{brain.BUN_VERSION}/bun-linux-x64.zip"]
    package = json.loads((brain.base() / "runtime" / "package.json").read_text())
    assert package["dependencies"]["gbrain"] == f"github:garrytan/gbrain#{brain.GBRAIN_COMMIT}"
    assert (brain.base() / "home" / ".gbrain" / "brain.pglite").exists()
    assert oct(brain.base().stat().st_mode & 0o777) == "0o700"
    assert "ready" in (brain.base() / "install.log").read_text()

    # A second run reuses everything rather than downloading again.
    brain.install()
    assert len(dolphin_home) == 1


def test_a_tampered_download_fails_setup_with_a_reason(dolphin_home, monkeypatch):
    monkeypatch.setitem(brain.BUN_SHA256, "linux-x64", "0" * 64)
    brain.install()
    status = brain.status()
    assert status["state"] == "failed" and "checksum" in status["error"]
    assert not (brain.base() / "bun" / "bun").exists()


def test_unsupported_platforms_fail_clearly(dolphin_home, monkeypatch):
    monkeypatch.setattr(brain, "_platform_key", lambda: None)
    brain.install()
    assert "does not support" in brain.status()["error"]


def test_setup_runs_in_the_background_and_reports_progress(dolphin_home):
    first = brain.start_install()
    assert first["state"] in ("installing", "ready")
    for _ in range(100):
        if brain.status()["state"] == "ready":
            break
        time.sleep(0.05)
    assert brain.status()["state"] == "ready"
    # Ready is final unless forced; a forced run re-checks and stays ready.
    assert brain.start_install()["state"] == "ready"


def test_calls_pass_the_tool_and_arguments_and_parse_past_notices(dolphin_home):
    brain.install()
    assert brain.call("recall", {"query": "tea"}) == {"tool": "recall", "args": {"query": "tea"}}


def test_calls_refuse_when_memory_is_not_set_up(dolphin_home):
    with pytest.raises(brain.BrainError, match="not set up"):
        brain.call("recall", {"query": "tea"})


def test_dolphins_own_brain_never_sees_provider_keys(dolphin_home, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-should-not-leak")
    environment = brain._environment()
    assert "OPENAI_API_KEY" not in environment
    assert environment["GBRAIN_HOME"] == str(brain.base() / "home")


@pytest.mark.asyncio
async def test_the_chat_recalls_and_remembers_through_the_brain(dolphin_home):
    from app import dolphin_agent_tools as tools_module

    if tools_module.EXTENSION:
        pytest.skip("an installed chat extension brings its own memory tools")
    names = lambda: {d["function"]["name"] for d in tools_module.tool_definitions()}  # noqa: E731
    assert "recall_memory" not in names()  # hidden until memory is set up

    brain.install()
    assert {"recall_memory", "remember", "search_brain", "read_brain_page"} <= names()
    async with httpx.AsyncClient(base_url="http://test") as api:
        tools = tools_module.DolphinTools(api, dispatch=None, turn_id="turn-1")
        recalled = await tools.execute("recall_memory", {"query": "tea", "entity": "user"})
        saved = await tools.execute("remember", {"fact": "Prefers tea.", "entity": "user", "evidence": "I like tea"})
    assert recalled["tool"] == "recall" and recalled["args"]["entity"] == "user"
    assert saved["tool"] == "remember" and saved["args"]["provenance"] == "Dolphin turn turn-1: I like tea"


def test_the_brain_path_has_no_symlinks_in_it(tmp_path, monkeypatch):
    real = tmp_path / "real"
    real.mkdir()
    (tmp_path / "link").symlink_to(real)
    monkeypatch.setenv("DOLPHIN_HOME", str(tmp_path / "link" / "dolphin"))
    assert brain.base() == (real / "dolphin" / "gbrain").resolve()


@pytest.fixture
def ask_home(dolphin_home, monkeypatch):
    """Helper mode's default since 0.2.0: memory waits for the user's choice."""
    monkeypatch.setenv("DOLPHIN_GBRAIN", "ask")
    return dolphin_home


def test_ask_mode_stays_off_until_the_user_opts_in(ask_home):
    assert brain.mode() == "off"
    assert brain.status() == {"state": "off", "optional": True}
    assert brain.start_install() == {"state": "off", "optional": True}
    assert ask_home == []  # nothing downloaded
    assert not (brain.base() / "bun").exists()


def test_opting_in_records_the_choice_and_starts_setup(ask_home, monkeypatch):
    started = []
    monkeypatch.setattr(brain, "start_install", lambda force=False: started.append(force) or {"state": "installing"})
    assert brain.set_consent(True) == {"state": "installing"}
    assert json.loads((brain.base() / "consent.json").read_text())["memory"] is True
    assert brain.consent() is True
    assert brain.mode() == "auto"
    assert started == [False]


def test_opting_out_turns_memory_off_and_keeps_its_files(ask_home, monkeypatch):
    monkeypatch.setattr(brain, "start_install", lambda force=False: brain.status())
    brain.set_consent(True)
    brain.install()
    assert brain.status()["state"] == "ready"
    assert brain.set_consent(False) == {"state": "off", "optional": True}
    assert brain.mode() == "off" and not brain.ready()
    assert (brain.base() / "runtime" / "node_modules" / "gbrain" / "src" / "cli.ts").exists()


def test_a_brain_set_up_before_0_2_0_stays_on(ask_home):
    # 0.1.x set memory up unasked: a ready brain, and no choice on record.
    paths = brain._paths()
    paths["cli"].parent.mkdir(parents=True)
    paths["cli"].write_text("// cli")
    brain._write_state(state="ready", version=brain.GBRAIN_VERSION)
    assert brain.consent() is None
    assert brain.mode() == "auto"
    assert brain.status()["state"] == "ready"
    brain.set_consent(False)
    assert brain.mode() == "off", "an explicit choice wins over the old install"


def test_opting_in_again_retries_a_failed_setup(ask_home, monkeypatch):
    brain._write_state(state="failed", error="Download failed")
    calls = []
    monkeypatch.setattr(brain, "start_install", lambda force=False: calls.append(force) or brain.status())
    brain.set_consent(True)
    assert calls == [True]


def test_the_environment_fixes_memory_outside_ask_mode(dolphin_home, monkeypatch):
    monkeypatch.setenv("DOLPHIN_GBRAIN", "off")
    assert brain.set_consent(True) == {"state": "off"}
    assert not (brain.base() / "consent.json").exists()


def test_the_consent_endpoint_takes_only_a_boolean(ask_home, monkeypatch):
    from fastapi.testclient import TestClient

    from app.main import app

    monkeypatch.setattr(brain, "start_install", lambda force=False: {"state": "installing", "step": "Starting…", "source": "dolphin"})
    client = TestClient(app)  # no lifespan: the endpoint needs no database
    assert client.post("/api/brain/consent", json={"enabled": "yes"}).status_code == 422
    assert client.post("/api/brain/consent", json={"enabled": True, "extra": 1}).status_code == 422
    assert client.post("/api/brain/consent", json={"enabled": True}).json()["state"] == "installing"
    assert client.post("/api/brain/consent", json={"enabled": False}).json() == {"state": "off", "optional": True}


def _wait_for(predicate, seconds=10):
    deadline = time.time() + seconds
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(0.02)
    return False


def test_opting_out_during_setup_stops_it_and_removes_only_its_partial_files(ask_home, monkeypatch):
    import threading

    paths = brain._paths()
    kept = paths["home"] / ".gbrain" / "brain.pglite"  # the user's data from an earlier install
    kept.parent.mkdir(parents=True)
    kept.write_text("data")
    inside, release, later = threading.Event(), threading.Event(), []

    def slow_gbrain(p):
        p["runtime"].mkdir(parents=True, exist_ok=True)
        (p["runtime"] / "package.json").write_text("{}")
        inside.set()
        release.wait(10)

    monkeypatch.setattr(brain, "_install_gbrain", slow_gbrain)
    monkeypatch.setattr(brain, "_initialise", lambda p: later.append("initialise"))
    monkeypatch.setattr(brain, "_self_test", lambda p: later.append("self_test"))
    brain.set_consent(True)
    assert inside.wait(10)
    assert brain.set_consent(False) == {"state": "off", "optional": True}
    release.set()
    assert _wait_for(lambda: brain._worker is None or not brain._worker.is_alive())
    assert later == [], "no step ran after the user said no"
    assert brain._read_state()["state"] == "off"
    assert not paths["runtime"].exists(), "this run's partial files are gone"
    assert kept.read_text() == "data", "an earlier brain is never touched"
    assert brain.status() == {"state": "off", "optional": True}


def test_opting_out_kills_the_step_it_started_by_pid(ask_home):
    import threading

    results = []
    runner = threading.Thread(target=lambda: results.append(brain._run(["30"], timeout=60, command=["sleep"])))
    runner.start()
    assert _wait_for(lambda: getattr(brain, "_child", None) is not None)
    pid = brain._child.pid
    brain.set_consent(False)
    runner.join(10)
    assert not runner.is_alive(), "the step was killed, not waited out"
    assert results[0].returncode != 0
    with pytest.raises(ProcessLookupError):
        import os
        os.kill(pid, 0)


def test_concurrent_choices_never_fail_and_the_last_wins(ask_home, monkeypatch):
    import threading

    monkeypatch.setattr(brain, "start_install", lambda force=False: brain.status())
    errors = []

    def choose(on):
        try:
            brain.set_consent(on)
        except Exception as error:  # noqa: BLE001
            errors.append(error)

    threads = [threading.Thread(target=choose, args=(index % 2 == 0,)) for index in range(40)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(10)
    assert errors == []
    brain.set_consent(False)
    assert brain.consent() is False
    brain.set_consent(True)
    assert brain.consent() is True
    assert [name for name in os.listdir(brain.base()) if name.startswith("consent")] == ["consent.json"]


def _settings_applied() -> list[str]:
    log = brain.base() / "home" / "config.log"
    return log.read_text().splitlines() if log.exists() else []


def test_setup_keeps_write_receipts_for_a_week(dolphin_home):
    brain.install()
    assert _settings_applied() == ["config set persistence.receipt_retention_days 7"]
    assert json.loads((brain.base() / "state.json").read_text())["receipt_retention_days"] == 7


def test_a_brain_from_an_earlier_dolphin_gets_the_setting_once(dolphin_home):
    brain.install()
    state = json.loads((brain.base() / "state.json").read_text())
    del state["receipt_retention_days"]
    (brain.base() / "state.json").write_text(json.dumps(state))
    (brain.base() / "home" / "config.log").unlink()
    brain.apply_settings()
    brain.apply_settings()
    assert _settings_applied() == ["config set persistence.receipt_retention_days 7"]
    assert brain.ready()
