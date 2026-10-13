"""The agent's turn state on a tmux pane: ``@dolphin-turn-state``.

The hook (agent_hook.py) writes "working <time>" when a prompt is submitted and
"finished <time>" when the turn ends. The session inventory (tmux_service.py)
and the collector (turn_notifications.py) read it back. Standard library only:
the hook imports it.
"""

from __future__ import annotations

from datetime import datetime, timezone

OPTION = "@dolphin-turn-state"
STATES = ("working", "finished")


def format_turn_state(state: str, at: datetime) -> str:
    if state not in STATES:
        raise ValueError(f"unknown turn state: {state}")
    if at.tzinfo is None:
        at = at.replace(tzinfo=timezone.utc)
    return f"{state} {at.astimezone(timezone.utc).isoformat()}"


def parse_turn_state(raw: str | None) -> tuple[str, datetime] | None:
    """(state, when) from the option's value, or None for anything else."""
    if not raw:
        return None
    state, _, when = raw.strip().partition(" ")
    if state not in STATES:
        return None
    try:
        at = datetime.fromisoformat(when)
    except ValueError:
        return None
    return state, at if at.tzinfo else at.replace(tzinfo=timezone.utc)
