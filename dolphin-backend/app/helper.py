"""The Dolphin helper: the backend as Dolphin Desktop runs it on each machine.

    python -m app.helper serve [--socket PATH | --port N] [--detach]
    python -m app.helper status
    python -m app.helper stop

Everything lives under ``DOLPHIN_HOME`` (default ``~/.dolphin-server``):

    data/dolphin.db, data/backups/   the database and its startup snapshots
    logs/                            request logs and the detached helper's output
    run/lock                         held for as long as a helper serves
    run/server.json                  how to reach the running helper
    run/helper.sock                  the default Unix socket, mode 0600
    token                            the shared secret every request must carry

On a remote machine the desktop app reaches the socket through an SSH forward,
so SSH is the login and the 0600 socket keeps other users of a shared server
out. Locally the helper listens on 127.0.0.1 and the token keeps other local
processes out. The long-running web install does not use this module.
"""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import secrets
import signal
import socket
import sys
import time
from pathlib import Path

from .version import VERSION

DESKTOP_ORIGIN = "app://dolphin"


def home() -> Path:
    return Path(os.getenv("DOLPHIN_HOME") or Path.home() / ".dolphin-server").expanduser()


def _paths(base: Path) -> dict[str, Path]:
    return {
        "data": base / "data",
        "logs": base / "logs",
        "run": base / "run",
        "lock": base / "run" / "lock",
        "server": base / "run" / "server.json",
        "socket": base / "run" / "helper.sock",
        "token": base / "token",
    }


def ensure_token(path: Path) -> str:
    """Create the token once, readable only by this user, and reuse it."""
    if path.exists():
        token = path.read_text().strip()
        if len(token) >= 32:
            return token
    token = secrets.token_urlsafe(32)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w") as handle:
        handle.write(token + "\n")
    return token


def configure_environment(base: Path, token: str) -> None:
    """Helper-mode defaults. Explicit environment always wins."""
    paths = _paths(base)
    defaults = {
        "DATABASE_URL": f"sqlite+aiosqlite:///{paths['data'] / 'dolphin.db'}",
        "DOLPHIN_BACKUP_DIR": str(paths["data"] / "backups"),
        "DOLPHIN_LOG_DIR": str(paths["logs"]),
        "DOLPHIN_WORKSPACE_ROOTS": str(Path.home()),
        "DOLPHIN_FLEET_ENABLED": "0",
        "DOLPHIN_CORS_ORIGINS": DESKTOP_ORIGIN,
        "DOLPHIN_SYSTEM_HEALTH_SOURCE": "auto",
        "DOLPHIN_GBRAIN": "auto",
        "DOLPHIN_TERMINAL_ATTACHMENT_ROOT": str(paths["data"] / "terminal-attachments"),
    }
    for key, value in defaults.items():
        os.environ.setdefault(key, value)
    # Started from inside a tmux pane, the helper would inherit that pane's
    # TMUX and send every tmux command to the pane's server, not the default one.
    os.environ.pop("TMUX", None)
    os.environ.pop("TMUX_PANE", None)
    os.environ["DOLPHIN_TOKEN"] = token
    os.environ["DOLPHIN_HELPER_VERSION"] = VERSION


def _tmux_version_ok(binary: str) -> bool:
    import re
    import subprocess

    try:
        output = subprocess.run([binary, "-V"], capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.SubprocessError):
        return False
    match = re.search(r"(\d+)\.(\d+)", output)
    return bool(match) and (int(match.group(1)), int(match.group(2))) >= (3, 0)


def bundled_tmux() -> Path | None:
    """The static tmux shipped beside the frozen helper, if any."""
    override = os.getenv("DOLPHIN_BUNDLED_TMUX")
    if override:
        return Path(override)
    if getattr(sys, "frozen", False):
        candidate = Path(sys.executable).resolve().parent / "tmux" / "tmux"
        return candidate if candidate.exists() else None
    return None


def configure_tmux(base: Path) -> str | None:
    """Use the host's tmux when it is 3.0 or newer; otherwise the bundled one.

    The bundled tmux runs on its own socket (-L dolphin) with its own terminfo,
    through a wrapper at <home>/bin/tmux that goes first on PATH, so the tmux
    server, its panes and the agent hooks inside them all use the same binary.
    Returns the wrapper path when the bundled tmux is in use.
    """
    import shutil

    system = shutil.which("tmux")
    if system and _tmux_version_ok(system) and not os.getenv("DOLPHIN_FORCE_BUNDLED_TMUX"):
        return None
    tmux = bundled_tmux()
    if tmux is None or not tmux.exists():
        return None
    bin_dir = base / "bin"
    bin_dir.mkdir(parents=True, exist_ok=True)
    wrapper = bin_dir / "tmux"
    terminfo = tmux.parent / "terminfo"
    wrapper.write_text(
        "#!/bin/sh\n"
        f'TERMINFO_DIRS="{terminfo}${{TERMINFO_DIRS:+:$TERMINFO_DIRS}}"; export TERMINFO_DIRS\n'
        f'exec "{tmux}" -L dolphin "$@"\n'
    )
    wrapper.chmod(0o700)
    os.environ["DOLPHIN_TMUX_BIN"] = str(wrapper)
    os.environ["PATH"] = f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}"
    return str(wrapper)


def read_server(base: Path) -> dict | None:
    try:
        return json.loads(_paths(base)["server"].read_text())
    except (OSError, ValueError):
        return None


def _running(base: Path) -> dict | None:
    """The live helper's server.json, or None. The lock is the source of truth:
    a server.json without a held lock is a leftover from a crash."""
    paths = _paths(base)
    if not paths["lock"].exists():
        return None
    with open(paths["lock"], "a+") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return read_server(base) or {"running": True}
        fcntl.flock(handle, fcntl.LOCK_UN)
    return None


def _write_json(path: Path, value: dict) -> None:
    temporary = path.with_suffix(".tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w") as handle:
        json.dump(value, handle)
    os.replace(temporary, path)


def _detach(log: Path) -> None:
    """Double fork so the helper outlives the SSH session that started it."""
    if os.fork() > 0:
        os._exit(0)
    os.setsid()
    if os.fork() > 0:
        os._exit(0)
    descriptor = os.open(log, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    null = os.open(os.devnull, os.O_RDONLY)
    os.dup2(null, 0)
    os.dup2(descriptor, 1)
    os.dup2(descriptor, 2)


def serve(args: argparse.Namespace) -> int:
    os.umask(0o077)
    base = home()
    paths = _paths(base)
    for key in ("data", "logs", "run"):
        paths[key].mkdir(parents=True, exist_ok=True)
    os.chmod(base, 0o700)

    running = _running(base)
    if running:
        print(json.dumps(running))
        return 0
    if args.detach:
        _detach(paths["logs"] / "helper.log")

    lock = open(paths["lock"], "a+")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:  # lost a race with another serve
        print(json.dumps(read_server(base) or {"running": True}))
        return 0

    token = ensure_token(paths["token"])
    configure_environment(base, token)
    tmux_wrapper = configure_tmux(base)
    from .agent_hooks_setup import write_shim

    write_shim(_self_command())

    import uvicorn

    from .main import app

    info: dict = {"version": VERSION, "pid": os.getpid(), "started_at": time.time(),
                  "tmux": "bundled" if tmux_wrapper else "system"}
    config_kwargs: dict = {"log_level": "warning", "proxy_headers": False, "access_log": False}
    if args.port is not None:
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind(("127.0.0.1", args.port))
        listener.listen(128)
        info["port"] = listener.getsockname()[1]
        os.environ["DOLPHIN_SELF_PORT"] = str(info["port"])
    else:
        path = Path(args.socket).expanduser() if args.socket else paths["socket"]
        if len(os.fsencode(path)) > 100:
            # sun_path holds 104 (macOS) to 108 (Linux) bytes. A deep home
            # directory overflows it, so fall back to a private short path;
            # server.json records where the socket really is.
            # One name per home, so two helpers never share (and unlink) a socket.
            digest = hashlib.sha256(str(base).encode()).hexdigest()[:12]
            path = Path(f"/tmp/dolphin-{os.getuid()}") / f"{digest}.sock"
            path.parent.mkdir(mode=0o700, exist_ok=True)
            if path.parent.stat().st_uid != os.getuid():
                raise SystemExit(f"{path.parent} belongs to another user")
            os.chmod(path.parent, 0o700)
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists() or path.is_symlink():
            path.unlink()
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        listener.bind(str(path))
        os.chmod(path, 0o600)
        listener.listen(128)
        info["socket"] = str(path)
        os.environ["DOLPHIN_SELF_SOCKET"] = str(path)

    _write_json(paths["server"], info)
    print(json.dumps(info), flush=True)
    try:
        # Pre-bound sockets: uvicorn's fd= option assumes AF_UNIX, sockets= takes either.
        uvicorn.Server(uvicorn.Config(app, **config_kwargs)).run(sockets=[listener])
    finally:
        try:
            if read_server(base) == info:
                paths["server"].unlink()
            if "socket" in info:
                Path(info["socket"]).unlink(missing_ok=True)
        except OSError:
            pass
    return 0


def _self_command() -> list[str]:
    """How to run this helper again: the frozen binary, or this Python module."""
    if getattr(sys, "frozen", False):
        return [sys.executable]
    return ["env", f"PYTHONPATH={Path(__file__).resolve().parents[1]}", sys.executable, "-m", "app.helper"]


def status(_args: argparse.Namespace) -> int:
    running = _running(home())
    print(json.dumps(running or {"running": False}))
    return 0 if running else 3


def stop(_args: argparse.Namespace) -> int:
    running = _running(home())
    if not running or "pid" not in running:
        print(json.dumps({"running": False}))
        return 0
    os.kill(int(running["pid"]), signal.SIGTERM)
    for _ in range(100):
        if not _running(home()):
            print(json.dumps({"stopped": True}))
            return 0
        time.sleep(0.1)
    print(json.dumps({"stopped": False}))
    return 1


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if argv[:1] == ["hook"]:
        # Runs at every agent Stop: skip argparse (it rejects --provider as a
        # leftover) and import nothing beyond the hook itself.
        from .agent_hook import main as hook_main

        return hook_main(argv[1:])
    parser = argparse.ArgumentParser(prog="dolphin-helper")
    commands = parser.add_subparsers(dest="command", required=True)
    serve_parser = commands.add_parser("serve", help="run the helper")
    where = serve_parser.add_mutually_exclusive_group()
    where.add_argument("--socket", help="Unix socket path (default run/helper.sock)")
    where.add_argument("--port", type=int, help="127.0.0.1 port; 0 picks a free one")
    serve_parser.add_argument("--detach", action="store_true", help="run in the background")
    serve_parser.set_defaults(handler=serve)
    commands.add_parser("status").set_defaults(handler=status)
    commands.add_parser("stop").set_defaults(handler=stop)
    commands.add_parser("version").set_defaults(handler=lambda _args: print(VERSION) or 0)
    commands.add_parser("hook", help="the Claude Code / Codex hook (called by agents)")
    args = parser.parse_args(argv)
    return args.handler(args)


if __name__ == "__main__":
    sys.exit(main())
