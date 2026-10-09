"""Which agent CLIs a host has, and how to install the missing ones.

The helper's own PATH is not the user's: a desktop app or a non-interactive
`ssh host cmd` starts it without the user's shell profile, so `claude` in
~/.local/bin or `codex` under nvm look missing. The terminals Dolphin opens run
the user's login shell, so that shell is asked first, with plain `which` and a
few well-known install directories as the fallback.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any

AGENTS = {"claude": "Claude Code", "codex": "Codex"}
TOOLS = ("claude", "codex", "npm", "brew")
MARK = "__dolphin_cli__"
CACHE_SECONDS = 10.0

CLAUDE_INSTALL = "curl -fsSL https://claude.ai/install.sh | bash"
NPM_CODEX_INSTALL = "npm install -g @openai/codex"
BREW_CODEX_INSTALL = "brew install --cask codex"

_cache: tuple[float, dict[str, str | None]] | None = None


def _extra_dirs() -> list[Path]:
    home = Path.home()
    return [home / ".local/bin", home / ".claude/local", home / ".npm-global/bin",
            Path("/opt/homebrew/bin"), Path("/usr/local/bin")]


def _login_shell_paths() -> dict[str, str | None]:
    shell = os.getenv("SHELL") or "/bin/sh"
    script = "; ".join(f'printf "{MARK}{tool}=%s\\n" "$(command -v {tool})"' for tool in TOOLS)
    try:
        result = subprocess.run([shell, "-ilc", script], stdin=subprocess.DEVNULL, capture_output=True,
                                text=True, timeout=6, env={**os.environ, "TERM": "dumb"})
    except (OSError, subprocess.TimeoutExpired):
        return {}
    found: dict[str, str | None] = {}
    for line in result.stdout.splitlines():
        if line.startswith(MARK) and "=" in line:
            tool, _, path = line[len(MARK):].partition("=")
            if tool in TOOLS:
                found[tool] = path.strip() if path.strip().startswith("/") else None
    return found


def _fallback(tool: str) -> str | None:
    found = shutil.which(tool)
    if found:
        return found
    for directory in _extra_dirs():
        candidate = directory / tool
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate)
    return None


def locate(refresh: bool = False) -> dict[str, str | None]:
    """Absolute path of each tool in TOOLS, or None."""
    global _cache
    if not refresh and _cache and time.monotonic() - _cache[0] < CACHE_SECONDS:
        return _cache[1]
    shell = _login_shell_paths()
    paths = {tool: shell.get(tool) or _fallback(tool) for tool in TOOLS}
    _cache = (time.monotonic(), paths)
    return paths


def _install_command(agent: str, paths: dict[str, str | None]) -> str | None:
    if agent == "claude":
        return CLAUDE_INSTALL if shutil.which("curl") else None
    if paths.get("npm"):
        return NPM_CODEX_INSTALL
    if paths.get("brew"):
        return BREW_CODEX_INSTALL
    return None


def status(refresh: bool = False) -> list[dict[str, Any]]:
    paths = locate(refresh)
    rows = []
    for agent, name in AGENTS.items():
        install = None if paths.get(agent) else _install_command(agent, paths)
        rows.append({
            "agent": agent,
            "name": name,
            "path": paths.get(agent),
            "found": paths.get(agent) is not None,
            "install_command": install,
            # Started right after the installer, in the same shell: the
            # installer may have put the CLI somewhere this shell's PATH lacks.
            "install_then_start": (
                f'{install} && {{ command -v {agent} >/dev/null || export PATH="$HOME/.local/bin:$PATH"; }} && {agent}'
                if install else None
            ),
            "install_hint": None if paths.get(agent) or install else (
                "Install Node.js (npm) first, then Codex." if agent == "codex" else "Install curl first, then Claude Code."
            ),
        })
    return rows
