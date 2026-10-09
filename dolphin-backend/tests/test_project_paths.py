"""Two projects must not point at the same directory.

`Project.path` carries no unique constraint and never has. That was invisible
while the picker badged an already-linked folder in its own list; deleting that
badge left nothing at all flagging a duplicate, and a duplicate is not cosmetic:
`require_workspace_path` resolves the path, so two projects on one directory
share every tmux session in it and each shows the other's work as its own.

The check is server-side rather than in the dialog because the dialog is one of
four entry points -- the rail's link form, the board's inline composer, and its
two modal empty states all reach the same two routes.
"""

import asyncio
from contextlib import asynccontextmanager
from pathlib import Path

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.database import Base
from app.main import create_project, update_project
from app.schemas import ProjectCreate, ProjectUpdate


@asynccontextmanager
async def _temporary_db(tmp_path: Path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'projects.db'}")
    sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    try:
        async with sessions() as db:
            yield db
    finally:
        await engine.dispose()


def test_linking_a_directory_twice_is_a_conflict(tmp_path):
    workspace = tmp_path / "alpha-service"
    workspace.mkdir()

    async def scenario():
        async with _temporary_db(tmp_path) as db:
            first = await create_project(
                ProjectCreate(name="Alpha", path=str(workspace)), db
            )
            with pytest.raises(HTTPException) as error:
                await create_project(
                    ProjectCreate(name="Alpha again", path=str(workspace)), db
                )
            return first, error.value

    first, error = asyncio.run(scenario())

    assert first.path == str(workspace)
    assert error.status_code == 409
    # Names the project holding the folder, and says what to do next.
    assert "Alpha" in error.detail
    assert "choose a different folder" in error.detail


def test_a_conflict_is_judged_on_the_resolved_path(tmp_path):
    """A trailing slash and a symlink are different strings for one directory,
    and it is the resolved directory that decides whether two projects end up
    sharing tmux sessions."""
    workspace = tmp_path / "alpha-service"
    workspace.mkdir()
    link = tmp_path / "alpha-link"
    link.symlink_to(workspace, target_is_directory=True)

    async def scenario():
        async with _temporary_db(tmp_path) as db:
            await create_project(ProjectCreate(name="Alpha", path=str(workspace)), db)
            refusals = []
            for candidate in (f"{workspace}/", str(link)):
                with pytest.raises(HTTPException) as error:
                    await create_project(
                        ProjectCreate(name="Duplicate", path=candidate), db
                    )
                refusals.append(error.value.status_code)
            return refusals

    assert asyncio.run(scenario()) == [409, 409]


def test_two_projects_without_a_path_are_not_duplicates(tmp_path):
    """Inbox-style projects have no directory at all. Treating "no path" as a
    shared path would refuse the second one ever created."""

    async def scenario():
        async with _temporary_db(tmp_path) as db:
            first = await create_project(ProjectCreate(name="Inbox"), db)
            second = await create_project(ProjectCreate(name="Later", path=""), db)
            return first, second

    first, second = asyncio.run(scenario())

    assert first.path is None
    assert second.path == ""


def test_a_different_directory_still_links(tmp_path):
    (tmp_path / "alpha").mkdir()
    (tmp_path / "beta").mkdir()

    async def scenario():
        async with _temporary_db(tmp_path) as db:
            await create_project(
                ProjectCreate(name="Alpha", path=str(tmp_path / "alpha")), db
            )
            return await create_project(
                ProjectCreate(name="Beta", path=str(tmp_path / "beta")), db
            )

    assert asyncio.run(scenario()).path == str(tmp_path / "beta")


def test_updating_a_project_onto_another_projects_directory_is_a_conflict(tmp_path):
    """The rail's "Update selected" button sends a path chosen from the same
    picker, so the create-side guard alone leaves the duplicate one click
    away."""
    alpha = tmp_path / "alpha"
    beta = tmp_path / "beta"
    alpha.mkdir()
    beta.mkdir()

    async def scenario():
        async with _temporary_db(tmp_path) as db:
            await create_project(ProjectCreate(name="Alpha", path=str(alpha)), db)
            moving = await create_project(ProjectCreate(name="Beta", path=str(beta)), db)
            with pytest.raises(HTTPException) as error:
                await update_project(moving.id, ProjectUpdate(path=str(alpha)), db)
            await db.rollback()
            unchanged = await update_project(moving.id, ProjectUpdate(name="Beta"), db)
            return error.value, unchanged

    error, unchanged = asyncio.run(scenario())

    assert error.status_code == 409
    assert "Alpha" in error.detail
    # The refused move left the project where it was.
    assert unchanged.path == str(beta)


def test_a_project_can_be_updated_onto_its_own_directory(tmp_path):
    """Re-saving the same folder -- renaming the project without moving it --
    must not collide with the project doing the saving."""
    alpha = tmp_path / "alpha"
    alpha.mkdir()

    async def scenario():
        async with _temporary_db(tmp_path) as db:
            created = await create_project(ProjectCreate(name="Alpha", path=str(alpha)), db)
            return await update_project(
                created.id, ProjectUpdate(name="Alpha renamed", path=str(alpha)), db
            )

    updated = asyncio.run(scenario())

    assert updated.name == "Alpha renamed"
    assert updated.path == str(alpha)
