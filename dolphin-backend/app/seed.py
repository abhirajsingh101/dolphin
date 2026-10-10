import os
from pathlib import Path

from sqlalchemy import select

from .models import Project

SEED_PROJECTS = [
    {"name": "Inbox", "emoji": "\U0001F4E5", "color": "#3B82F6", "is_inbox": True, "position": 0},
]


async def seed_projects(session):
    """A new database starts with the Inbox; every other project is the user's own."""
    result = await session.execute(select(Project).limit(1))
    if result.scalar_one_or_none() is not None:
        return
    for data in SEED_PROJECTS:
        session.add(Project(**data))
    await session.commit()


def inbox_folder() -> Path | None:
    """Where the Inbox works when the user has not linked it anywhere: its own
    folder beside this machine's brain, <DOLPHIN_HOME>/gbrain/dolphin-inbox
    (next to the brain's data in gbrain/home), or DOLPHIN_INBOX_PATH."""
    explicit = os.getenv("DOLPHIN_INBOX_PATH")
    if explicit:
        return Path(explicit).expanduser()
    from . import brain

    # Dolphin Desktop's helper always has one, memory on or off.
    if brain.mode() == "auto" or os.getenv("DOLPHIN_HELPER_VERSION"):
        return brain.base() / "dolphin-inbox"
    return None


def _previous_default() -> str | None:
    """Where 0.1.3-0.1.5 put the Inbox: inside the brain's own data folder."""
    from . import brain

    return str(brain.base() / "home")


async def link_inbox(session) -> None:
    """Give an Inbox with no folder its own, so its sessions can start.

    An Inbox still on the earlier default (the brain's data folder) moves to the
    new one. A folder the user chose stays, and one another project already
    holds is left alone.
    """
    folder = inbox_folder()
    inbox = await session.scalar(select(Project).where(Project.is_inbox.is_(True)).limit(1))
    if folder is None or inbox is None:
        return
    if inbox.path and inbox.path != _previous_default():
        return
    folder.mkdir(parents=True, exist_ok=True)
    taken = await session.scalar(select(Project.id).where(Project.path == str(folder)).limit(1))
    if taken or inbox.path == str(folder):
        return
    inbox.path = str(folder)
    await session.commit()
