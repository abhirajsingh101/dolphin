"""Turn on finished-turn notifications for Claude Code and Codex, with consent.

Dolphin Desktop's helper writes a stable shim, ``<DOLPHIN_HOME>/bin/dolphin-hook``,
that runs ``dolphin-helper hook``. This module adds that shim to each agent's
hook settings (Stop and UserPromptSubmit), keeping everything else in the file
and a one-time backup beside it. For Codex it also turns on ``features.hooks``;
Codex then asks the user once to trust the new hook, as it should.

An existing install of Dolphin's server hook (scripts/dolphin-automation-hook)
counts as on, so a machine never ends up with two hooks reporting each turn.
"""

from __future__ import annotations

import json
import os
import re
import shlex
import shutil
import tempfile
import tomllib
from pathlib import Path
from typing import Any

from . import agent_clis

EVENTS = {"UserPromptSubmit": "user_prompt_submit", "Stop": "stop"}
AGENTS = ("claude", "codex")


def shim_path() -> Path:
    home = Path(os.getenv("DOLPHIN_HOME") or Path.home() / ".dolphin-server")
    return home / "bin" / "dolphin-hook"


def write_shim(command: list[str]) -> Path:
    """The stable command agents call; it follows the helper across upgrades."""
    path = shim_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("#!/bin/sh\nexec " + " ".join(shlex.quote(part) for part in command) + ' hook "$@"\n')
    path.chmod(0o700)
    return path


def _settings(agent: str) -> Path:
    return Path.home() / (".claude/settings.json" if agent == "claude" else ".codex/hooks.json")


def _ours(command: str) -> str | None:
    """'dolphin' for our shim, 'server' for this repo's script, else None."""
    try:
        first = shlex.split(command)[0]
    except (ValueError, IndexError):
        return None
    if Path(first).name == "dolphin-hook" and Path(first).parent.name == "bin":
        return "dolphin"
    if Path(first).name == "dolphin-automation-hook":
        return "server"
    return None


def _entries(data: dict[str, Any], event: str) -> list:
    hooks = data.get("hooks")
    entries = hooks.get(event, []) if isinstance(hooks, dict) else []
    return entries if isinstance(entries, list) else []


def _installed_kind(data: dict[str, Any], agent: str) -> str | None:
    for entry in _entries(data, "Stop"):
        for hook in entry.get("hooks", []) if isinstance(entry, dict) else []:
            command = hook.get("command") if isinstance(hook, dict) else None
            if isinstance(command, str) and f"--provider {agent}" in command:
                kind = _ours(command)
                if kind:
                    return kind
    return None


def _read_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    data = json.loads(path.read_text() or "{}")
    if not isinstance(data, dict):
        raise ValueError(f"{path} does not contain a JSON object")
    return data


def _codex_hooks_enabled() -> bool:
    config = Path.home() / ".codex" / "config.toml"
    try:
        return bool(tomllib.loads(config.read_text()).get("features", {}).get("hooks"))
    except (OSError, tomllib.TOMLDecodeError):
        return False


def status() -> list[dict[str, Any]]:
    rows = []
    paths = agent_clis.locate()
    for agent in AGENTS:
        path = _settings(agent)
        try:
            kind = _installed_kind(_read_json(path), agent)
            readable = True
        except (OSError, ValueError):
            kind, readable = None, False
        rows.append({
            "agent": agent,
            "cli_found": paths.get(agent) is not None,
            "settings_path": str(path),
            "installed": kind is not None and (agent != "codex" or _codex_hooks_enabled()),
            "via": kind,
            "readable": readable,
        })
    return rows


def _atomic_write(path: Path, text: str, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        os.fchmod(descriptor, mode)
        with os.fdopen(descriptor, "w") as handle:
            handle.write(text)
        os.replace(temporary, path)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise


def _backup_once(path: Path) -> None:
    backup = path.with_name(path.name + ".before-dolphin")
    if path.exists() and not backup.exists():
        shutil.copy2(path, backup)


def _enable_codex_feature() -> None:
    """features.hooks = true, edited as text so the user's file keeps its comments."""
    config = Path.home() / ".codex" / "config.toml"
    text = config.read_text() if config.exists() else ""
    if _codex_hooks_enabled():
        return
    _backup_once(config)
    if re.search(r"(?m)^\[features\]\s*$", text):
        if re.search(r"(?ms)^\[features\]\s*$.*?^hooks\s*=", text):
            text = re.sub(r"(?ms)(^\[features\]\s*$.*?^)hooks\s*=\s*\S+", r"\1hooks = true", text, count=1)
        else:
            text = re.sub(r"(?m)^\[features\]\s*$", "[features]\nhooks = true", text, count=1)
    else:
        text = text.rstrip("\n") + ("\n\n" if text else "") + "[features]\nhooks = true\n"
    tomllib.loads(text)  # never write a file Codex cannot read
    _atomic_write(config, text, config.stat().st_mode & 0o777 if config.exists() else 0o600)


def install(agents: list[str]) -> list[dict[str, Any]]:
    shim = shim_path()
    if not shim.exists():
        raise FileNotFoundError("Dolphin's hook shim is missing; restart Dolphin and try again.")
    for agent in agents:
        if agent not in AGENTS:
            raise ValueError(f"unknown agent: {agent}")
        path = _settings(agent)
        data = _read_json(path)
        if _installed_kind(data, agent) is None:
            hooks = data.setdefault("hooks", {})
            if not isinstance(hooks, dict):
                raise ValueError(f"{path} has an unexpected hooks section")
            for event, name in EVENTS.items():
                entries = [entry for entry in _entries(data, event)
                           if not any(_ours(h.get("command", "")) == "dolphin" for h in entry.get("hooks", []) if isinstance(h, dict))]
                entries.append({"hooks": [{"type": "command", "timeout": 2,
                                           "command": shlex.join([str(shim), "--provider", agent, "--event", name])}]})
                hooks[event] = entries
            _backup_once(path)
            _atomic_write(path, json.dumps(data, indent=2) + "\n",
                          path.stat().st_mode & 0o777 if path.exists() else 0o600)
        if agent == "codex":
            _enable_codex_feature()
    return status()
