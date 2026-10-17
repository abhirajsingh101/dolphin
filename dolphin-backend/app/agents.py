"""Which coding agent to use: whichever of Claude Code and Codex this machine has.

Every feature that runs an agent asks here instead of assuming one. The
preferred agent is used when it is installed, otherwise the other one; with
neither, callers say so. Detection is agent_clis.locate, which finds agents
on the user's login-shell PATH (a helper started by an app or over SSH does
not inherit it, so shutil.which alone misses agents in ~/.local/bin or nvm).
"""

from __future__ import annotations

from . import agent_clis

AGENTS = ("claude", "codex")
NAMES = {"claude": "Claude Code", "codex": "Codex"}


def paths() -> dict[str, str | None]:
    found = agent_clis.locate()
    return {agent: found.get(agent) for agent in AGENTS}


def order(preferred: str | None = "claude") -> list[str]:
    """The installed agents, the preferred one first."""
    first = preferred if preferred in AGENTS else "claude"
    found = paths()
    return [agent for agent in (first, *(a for a in AGENTS if a != first)) if found.get(agent)]


def pick(preferred: str | None = "claude") -> str | None:
    """The agent to run: the preferred one if installed, else the other, else None."""
    ranked = order(preferred)
    return ranked[0] if ranked else None


def substitute(mode: str) -> tuple[str, str | None]:
    """For a session asked to start ``mode``: the mode to start, and a note
    when it had to change. A shell or terminal is never changed; an agent that
    is missing becomes the other one when that one is installed."""
    if mode not in AGENTS:
        return mode, None
    chosen = pick(mode)
    if chosen is None or chosen == mode:
        return mode, None
    return chosen, f"{NAMES[mode]} isn't installed on this machine, so this session started {NAMES[chosen]}."
