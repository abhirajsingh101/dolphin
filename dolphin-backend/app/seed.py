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
