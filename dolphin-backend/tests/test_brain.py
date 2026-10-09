"""Dolphin's memory: setting up a GBrain per machine, and calling it from the chat.

Nothing here downloads anything. A fake Bun stands in for the real one: it
"installs" GBrain, "creates" the brain and answers calls, the way the real
pieces do, so setup's steps, state and failures are all exercised.
"""

from __future__ import annotations

import hashlib
import io
import json
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
