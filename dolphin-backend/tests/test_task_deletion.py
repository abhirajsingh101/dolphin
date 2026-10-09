from pathlib import Path

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.database import Base
from app.main import delete_completed_tasks
from app.models import Project, Task
from app.schemas import CompletedTaskDeleteRequest


@pytest.mark.asyncio
async def test_delete_completed_tasks_only_removes_requested_done_rows(
    tmp_path: Path,
):
    engine = create_async_engine(
        f"sqlite+aiosqlite:///{tmp_path / 'task-deletion.db'}"
    )
    sessions = async_sessionmaker(
        engine,
        class_=AsyncSession,
        expire_on_commit=False,
    )
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    try:
        async with sessions() as db:
            project = Project(
                id="project-1",
                name="Dolphin Tasks",
                path=str(tmp_path),
                color="#176B87",
                position=0,
            )
            db.add_all(
                [
                    project,
                    Task(
                        id="done-1",
                        project_id=project.id,
                        title="First completed task",
                        is_done=True,
                        position=0,
                    ),
                    Task(
                        id="open-1",
                        project_id=project.id,
                        title="Reopened task",
                        is_done=False,
                        position=1,
                    ),
                    Task(
                        id="done-2",
                        project_id=project.id,
                        title="Second completed task",
                        is_done=True,
                        position=2,
                    ),
                ]
            )
            await db.commit()

            response = await delete_completed_tasks(
                CompletedTaskDeleteRequest(
                    task_ids=[
                        "done-2",
                        "open-1",
                        "missing",
                        "done-1",
                        "done-1",
                    ]
                ),
                db,
            )

            assert response.deleted_task_ids == ["done-2", "done-1"]
            assert response.skipped_task_ids == ["open-1", "missing"]
            remaining = await db.scalars(select(Task).order_by(Task.id))
            assert [task.id for task in remaining.all()] == ["open-1"]
    finally:
        await engine.dispose()
