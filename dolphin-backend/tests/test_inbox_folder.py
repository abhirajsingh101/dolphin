"""The Inbox works in the brain's home, so its sessions can start."""

from __future__ import annotations

import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app import brain
from app.database import Base
from app.models import Project
from app.seed import inbox_folder, link_inbox, seed_projects


@pytest_asyncio.fixture
async def factory():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    yield async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    await engine.dispose()


async def _inbox(factory):
    async with factory() as db:
        return await db.scalar(select(Project).where(Project.is_inbox.is_(True)))


@pytest.mark.asyncio
async def test_a_new_inbox_works_in_the_brains_home(factory, tmp_path, monkeypatch):
    monkeypatch.setenv("DOLPHIN_HOME", str(tmp_path / "dolphin"))
    monkeypatch.setenv("DOLPHIN_GBRAIN", "auto")
    monkeypatch.delenv("DOLPHIN_GBRAIN_COMMAND", raising=False)
    monkeypatch.delenv("DOLPHIN_INBOX_PATH", raising=False)
    async with factory() as db:
        await seed_projects(db)
        await link_inbox(db)
    home = brain.base() / "home"
    assert (await _inbox(factory)).path == str(home) and home.is_dir()


@pytest.mark.asyncio
async def test_a_folder_the_user_chose_stays(factory, tmp_path, monkeypatch):
    monkeypatch.setenv("DOLPHIN_INBOX_PATH", str(tmp_path / "brain"))
    async with factory() as db:
        await seed_projects(db)
        inbox = await db.scalar(select(Project).where(Project.is_inbox.is_(True)))
        inbox.path = str(tmp_path / "mine")
        await db.commit()
        await link_inbox(db)
    assert (await _inbox(factory)).path == str(tmp_path / "mine")


@pytest.mark.asyncio
async def test_a_folder_another_project_holds_is_left_alone(factory, tmp_path, monkeypatch):
    monkeypatch.setenv("DOLPHIN_INBOX_PATH", str(tmp_path / "brain"))
    async with factory() as db:
        await seed_projects(db)
        db.add(Project(id="notes", name="Notes", path=str(tmp_path / "brain")))
        await db.commit()
        await link_inbox(db)
    assert (await _inbox(factory)).path is None


def test_the_web_install_leaves_the_inbox_alone_unless_told(monkeypatch):
    monkeypatch.delenv("DOLPHIN_INBOX_PATH", raising=False)
    monkeypatch.delenv("DOLPHIN_GBRAIN_COMMAND", raising=False)
    monkeypatch.setenv("DOLPHIN_GBRAIN", "off")
    assert inbox_folder() is None
