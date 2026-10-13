"""What a machine has, for Dolphin Desktop's first-run checklist and its bug
reports: the helper's version, its tmux, and whether each agent CLI is signed in.

Signed in is read from where each CLI keeps its login, by existence only, and
nothing read here leaves this module except a yes or no. The CLIs are not run:
`claude auth status` rewrites ~/.claude.json and leaves a backup beside it on
every call, and `codex login status` tries to create PATH aliases (both checked
2026-10-12).
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any

from . import agent_clis
from .terminal_attach import binary_key
from .version import VERSION


# Raw `tmux -V` text keeps suffixes like "3.7c" that the (major, minor) cache in
# terminal_attach drops. Cached per installed file, parsed answers only.
_VERSIONS: dict[tuple[str, int, int], str] = {}


def _dolphin_home() -> Path:
    return Path(os.getenv("DOLPHIN_HOME") or Path.home() / ".dolphin-server")


def tmux_info() -> dict[str, Any]:
    """The tmux Dolphin drives here, and whether it is Dolphin's bundled one
    (helper.configure_tmux puts its wrapper at <DOLPHIN_HOME>/bin/tmux)."""
    binary = os.getenv("DOLPHIN_TMUX_BIN") or shutil.which("tmux")
    if not binary:
        return {"version": None, "bundled": False}
    key = binary_key(binary)
    version = _VERSIONS.get(key) if key else None
    if version is None and key is not None:
        try:
            output = subprocess.run([binary, "-V"], capture_output=True, text=True, timeout=5).stdout
        except (OSError, subprocess.SubprocessError):
            return {"version": None, "bundled": False}
        match = re.search(r"(\d+\.\d+[a-z]?)", output)
        version = match.group(1) if match else None
        if version:
            _VERSIONS[key] = version
    return {"version": version,
            "bundled": Path(binary) == _dolphin_home() / "bin" / "tmux"}


def claude_signed_in(home: Path) -> bool:
    config = Path(os.getenv("CLAUDE_CONFIG_DIR") or home / ".claude")
    credentials = config / ".credentials.json"
    if credentials.is_file() and credentials.stat().st_size > 0:
        return True
    # macOS keeps the token in the Keychain; ~/.claude.json then names the
    # signed-in account. Only the key's presence is used.
    try:
        account = json.loads((home / ".claude.json").read_text())
    except (OSError, ValueError):
        account = None
    if isinstance(account, dict) and account.get("oauthAccount"):
        return True
    return bool(os.getenv("ANTHROPIC_API_KEY") or os.getenv("CLAUDE_CODE_OAUTH_TOKEN"))


def codex_signed_in(home: Path) -> bool:
    auth = Path(os.getenv("CODEX_HOME") or home / ".codex") / "auth.json"
    return auth.exists() or bool(os.getenv("OPENAI_API_KEY"))


def snapshot() -> dict[str, Any]:
    home = Path.home()
    paths = agent_clis.locate()
    checks = {"claude": claude_signed_in, "codex": codex_signed_in}
    return {
        "helper_version": VERSION,
        "tmux": tmux_info(),
        "agents": [{
            "agent": agent,
            "found": paths.get(agent) is not None,
            "signed_in": checks[agent](home) if paths.get(agent) else None,
        } for agent in ("claude", "codex")],
    }
