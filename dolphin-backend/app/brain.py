"""Dolphin's long-term memory: a GBrain on each machine.

GBrain (github.com/garrytan/gbrain, MIT) is a personal knowledge brain with an
embedded database (PGlite). Dolphin installs one per machine, under
<DOLPHIN_HOME>/gbrain, the first time its helper starts:

    bun/        Bun, the runtime GBrain needs (checksum-verified download)
    runtime/    GBrain itself, pinned to one release
    home/       the brain (GBRAIN_HOME): its database and config
    state.json  where setup stands, for the UI

The brain starts keyless: keyword search and the memory verbs work with no API
key and no cost. The chat reaches it through `gbrain call <tool> <json>`, one
short-lived process per call, so nothing listens on a port.

DOLPHIN_GBRAIN selects the mode: "auto" (install and use Dolphin's own brain;
the helper's default) or "off" (the web install's default). DOLPHIN_GBRAIN_COMMAND
points Dolphin at an existing GBrain instead, e.g. "/opt/gbrain/bin/gbrain".
"""

from __future__ import annotations

import json
import os
import platform
import shlex
import shutil
import subprocess
import tempfile
import threading
import time
import zipfile
from pathlib import Path
from typing import Any

BUN_VERSION = "1.4.2"
BUN_SHA256 = {
    "linux-x64": "36368faef7527875d5ffa52e53cd48021741f2a83eb6208a8dd64068d422a913",
    "linux-aarch64": "54328bbc2d9c8e0c9f892c544d66c57a83b84139e34909e5ee81758f1ac8fda7",
    "darwin-x64": "80520d7e17526308c9185d261679ac6d27798d3803a0e9f7ff9121ab8affb012",
    "darwin-aarch64": "90987a3a16d7db556d886ac3d551e7b6d3edf0a1cf43acaed622e8676be1d12f",
}
GBRAIN_VERSION = "0.60.110.0"
GBRAIN_COMMIT = "1935c74a9e217b276c7bbf3075ddd3c220e96a09"  # tag v0.60.110.0
CALL_TIMEOUT = 60
INSTALL_TIMEOUT = 900

_lock = threading.Lock()
_worker: threading.Thread | None = None


class BrainError(RuntimeError):
    pass


# --- where things live -----------------------------------------------------------

def base() -> Path:
    home = Path(os.getenv("DOLPHIN_HOME") or Path.home() / ".dolphin-server")
    # Resolved: GBrain refuses a brain whose path runs through a symlink, and
    # on macOS /var and /tmp are symlinks (as a home directory can be anywhere).
    return (home / "gbrain").resolve()


def _paths() -> dict[str, Path]:
    root = base()
    return {
        "root": root,
        "bun": root / "bun" / "bun",
        "runtime": root / "runtime",
        "cli": root / "runtime" / "node_modules" / "gbrain" / "src" / "cli.ts",
        "home": root / "home",
        "cache": root / "cache",
        "state": root / "state.json",
        "log": root / "install.log",
    }


def mode() -> str:
    if os.getenv("DOLPHIN_GBRAIN_COMMAND"):
        return "external"
    return "auto" if os.getenv("DOLPHIN_GBRAIN", "off") == "auto" else "off"


def _platform_key() -> str | None:
    system = {"Linux": "linux", "Darwin": "darwin"}.get(platform.system())
    machine = {"x86_64": "x64", "amd64": "x64", "arm64": "aarch64", "aarch64": "aarch64"}.get(platform.machine().lower())
    return f"{system}-{machine}" if system and machine else None


# --- state ---------------------------------------------------------------------

def _read_state() -> dict[str, Any]:
    try:
        return json.loads(_paths()["state"].read_text())
    except (OSError, ValueError):
        return {}


def _write_state(**state: Any) -> None:
    path = _paths()["state"]
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps({**state, "updated_at": time.time()}))
    os.replace(temporary, path)


def status() -> dict[str, Any]:
    """What the UI shows: off, installing (with the current step), ready or failed."""
    current = mode()
    if current == "off":
        return {"state": "off"}
    if current == "external":
        return {"state": "ready", "source": "external"}
    state = _read_state()
    installing = _worker is not None and _worker.is_alive()
    if installing:
        return {"state": "installing", "step": state.get("step", "Starting…"), "source": "dolphin"}
    if state.get("state") == "ready" and _paths()["cli"].exists():
        return {"state": "ready", "source": "dolphin", "version": state.get("version"), "keyless": True}
    if state.get("state") == "failed":
        return {"state": "failed", "source": "dolphin", "error": state.get("error", "Setup failed.")}
    return {"state": "missing", "source": "dolphin"}


def ready() -> bool:
    return status()["state"] == "ready"


# --- running gbrain -------------------------------------------------------------

def _command() -> list[str]:
    external = os.getenv("DOLPHIN_GBRAIN_COMMAND")
    if external:
        return shlex.split(external)
    paths = _paths()
    return [str(paths["bun"]), str(paths["cli"])]


def _environment() -> dict[str, str]:
    """Dolphin's own brain gets a minimal environment, so provider keys in the
    user's shell never switch on paid features they did not choose here."""
    if os.getenv("DOLPHIN_GBRAIN_COMMAND"):
        return dict(os.environ)
    paths = _paths()
    environment = {
        "HOME": str(Path.home()),
        "PATH": f"{paths['bun'].parent}{os.pathsep}/usr/bin{os.pathsep}/bin",
        "GBRAIN_HOME": str(paths["home"]),
        "BUN_INSTALL_CACHE_DIR": str(paths["cache"]),
        "LANG": os.getenv("LANG", "C.UTF-8"),
    }
    return environment


def _run(arguments: list[str], *, timeout: float, cwd: Path | None = None, command: list[str] | None = None,
         stdin: str | None = None) -> subprocess.CompletedProcess:
    try:
        return subprocess.run([*(command or _command()), *arguments], cwd=cwd, env=_environment(),
                              input=stdin, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired as error:
        raise BrainError(f"GBrain did not answer within {timeout:g} seconds.") from error
    except OSError as error:
        raise BrainError(f"GBrain could not start: {error}") from error


def _parse(stdout: str) -> Any:
    text = stdout.strip()
    try:
        return json.loads(text)
    except ValueError:
        # Notices (an available upgrade, say) can precede the JSON.
        starts = [index for index in (text.find("{"), text.find("[")) if index >= 0]
        if starts:
            try:
                return json.loads(text[min(starts):])
            except ValueError:
                pass
    raise BrainError("GBrain returned something that is not JSON.")


def call(tool: str, arguments: dict[str, Any], timeout: float = CALL_TIMEOUT) -> Any:
    """One GBrain tool call. Raises BrainError when the brain is unavailable."""
    if not ready():
        raise BrainError("Dolphin's memory is not set up on this machine yet.")
    result = _run(["call", tool, json.dumps(arguments)], timeout=timeout)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip().splitlines()[-1:] or ["no detail"]
        raise BrainError(f"GBrain {tool} failed: {detail[0][:300]}")
    return _parse(result.stdout)


# --- installing -----------------------------------------------------------------

def _log(message: str) -> None:
    path = _paths()["log"]
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as handle:
        handle.write(f"{time.strftime('%Y-%m-%dT%H:%M:%S')} {message}\n")


def _step(text: str) -> None:
    _log(text)
    _write_state(state="installing", step=text)


def _download(url: str, target: Path) -> None:
    # curl, not urllib: a frozen helper's Python may not find the system's CA
    # certificates on macOS; curl always does.
    result = subprocess.run(["curl", "-fsSL", "--retry", "3", "-o", str(target), url],
                            capture_output=True, text=True, timeout=300)
    if result.returncode != 0:
        raise BrainError(f"Download failed ({url}): {result.stderr.strip()[:200]}")


def _sha256(path: Path) -> str:
    import hashlib

    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _install_bun(paths: dict[str, Path], key: str) -> None:
    if paths["bun"].exists():
        return
    _step("Downloading Bun…")
    with tempfile.TemporaryDirectory() as scratch:
        archive = Path(scratch) / "bun.zip"
        _download(f"https://github.com/oven-sh/bun/releases/download/bun-v{BUN_VERSION}/bun-{key}.zip", archive)
        if _sha256(archive) != BUN_SHA256[key]:
            raise BrainError("The Bun download did not match its published checksum.")
        with zipfile.ZipFile(archive) as bundle:
            member = f"bun-{key}/bun"
            paths["bun"].parent.mkdir(parents=True, exist_ok=True)
            with bundle.open(member) as source, open(paths["bun"], "wb") as target:
                shutil.copyfileobj(source, target)
    paths["bun"].chmod(0o755)


def _install_gbrain(paths: dict[str, Path]) -> None:
    _step(f"Installing GBrain {GBRAIN_VERSION}…")
    paths["runtime"].mkdir(parents=True, exist_ok=True)
    (paths["runtime"] / "package.json").write_text(json.dumps({
        "name": "dolphin-gbrain-runtime",
        "private": True,
        "dependencies": {"gbrain": f"github:garrytan/gbrain#{GBRAIN_COMMIT}"},
    }, indent=2) + "\n")
    result = _run(["install", "--no-progress"], timeout=INSTALL_TIMEOUT, cwd=paths["runtime"], command=[str(paths["bun"])])
    _log(result.stdout[-2000:] + result.stderr[-2000:])
    if result.returncode != 0 or not paths["cli"].exists():
        raise BrainError("Installing GBrain failed; see ~/.dolphin-server/gbrain/install.log.")


def _initialise(paths: dict[str, Path]) -> None:
    if (paths["home"] / ".gbrain" / "brain.pglite").exists():
        return
    _step("Creating your brain…")
    paths["home"].mkdir(parents=True, exist_ok=True)
    result = _run(["init", "--pglite", "--json"], timeout=300, cwd=paths["home"])
    _log(result.stdout[-2000:] + result.stderr[-2000:])
    if result.returncode != 0:
        raise BrainError("Creating the brain failed; see ~/.dolphin-server/gbrain/install.log.")


def _self_test(paths: dict[str, Path]) -> None:
    _step("Checking memory…")
    result = _run(["call", "recall", json.dumps({"query": "dolphin", "limit": 1})], timeout=CALL_TIMEOUT, cwd=paths["home"])
    if result.returncode != 0:
        _log(result.stderr[-2000:])
        raise BrainError("The new brain did not answer a recall; see ~/.dolphin-server/gbrain/install.log.")
    _parse(result.stdout)


def install() -> None:
    """Install Bun and GBrain, create the brain, and check it. Safe to re-run."""
    paths = _paths()
    key = _platform_key()
    try:
        if key is None or key not in BUN_SHA256:
            raise BrainError(f"Dolphin's memory does not support {platform.system()} {platform.machine()} yet.")
        if shutil.which("curl") is None:
            raise BrainError("Setting up memory needs curl, which this machine does not have.")
        paths["root"].mkdir(parents=True, exist_ok=True)
        os.chmod(paths["root"], 0o700)
        _install_bun(paths, key)
        if not paths["cli"].exists():
            _install_gbrain(paths)
        _initialise(paths)
        _self_test(paths)
        shutil.rmtree(paths["cache"], ignore_errors=True)  # Bun's download cache: ~150 MB, not needed again
        _log("ready")
        _write_state(state="ready", version=GBRAIN_VERSION)
    except BrainError as error:
        _log(f"failed: {error}")
        _write_state(state="failed", error=str(error))
    except Exception as error:  # setup must never take the helper down
        _log(f"failed: {error!r}")
        _write_state(state="failed", error=f"Setup failed: {error}")


def start_install(force: bool = False) -> dict[str, Any]:
    """Begin setup in the background unless it is running or already done."""
    global _worker
    with _lock:
        if mode() != "auto":
            return status()
        if _worker is not None and _worker.is_alive():
            return status()
        if not force and status()["state"] in ("ready", "failed"):
            return status()
        _write_state(state="installing", step="Starting…")
        _worker = threading.Thread(target=install, name="gbrain-install", daemon=True)
        _worker.start()
    return status()
