import importlib
from contextlib import asynccontextmanager
from pathlib import Path

import pytest
from fastapi import HTTPException
from fastapi.routing import APIRoute
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.database import Base
from app.models import Project, Task


@asynccontextmanager
async def _temporary_db(tmp_path: Path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'quality-loop.db'}")
    sessions = async_sessionmaker(
        engine,
        class_=AsyncSession,
        expire_on_commit=False,
    )
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    try:
        async with sessions() as db:
            yield db
    finally:
        await engine.dispose()


async def _seed(db: AsyncSession) -> tuple[Project, Task]:
    project = Project(
        id="project-quality",
        name="Dolphin Tasks",
        path="/tmp/dolphin-quality",
        color="#176B87",
    )
    task = Task(
        id="task-quality",
        project_id=project.id,
        title="Protect completion authority",
        description="Completion must require independently accepted evidence.",
        priority=1,
    )
    db.add_all([project, task])
    await db.commit()
    return project, task


def _contract_request(**updates):
    schemas = importlib.import_module("app.quality_schemas")
    values = {
        "desired_outcome": "Completion has durable independent proof.",
        "risk_level": "high",
        "stage": "plan",
        "acceptance_checks": [
            {
                "id": "completion-gate",
                "description": "The task cannot self-certify Done.",
            },
            {
                "id": "independent-review",
                "description": "A distinct reviewer accepts the evidence.",
            },
        ],
        "required_skills": [],
        "human_review_required": True,
    }
    values.update(updates)
    return schemas.QualityContractUpsert(**values)


def _evidence_request(**updates):
    schemas = importlib.import_module("app.quality_schemas")
    values = {
        "contract_revision": 1,
        "producer": "executor:codex",
        "summary": "The completion gate and reviewer separation tests pass.",
        "checks": [
            {
                "check_id": "completion-gate",
                "passed": True,
                "evidence": "test_completion_gate passed",
            },
            {
                "check_id": "independent-review",
                "passed": True,
                "evidence": "test_independent_review passed",
            },
        ],
    }
    values.update(updates)
    return schemas.EvidenceSubmit(**values)


def test_contract_upsert_cannot_enter_evidence_owned_stages():
    with pytest.raises(ValueError, match="review or done"):
        _contract_request(stage="review")
    with pytest.raises(ValueError, match="review or done"):
        _contract_request(stage="done")


@pytest.mark.asyncio
async def test_quality_contract_gates_done_until_independent_acceptance(tmp_path):
    service = importlib.import_module("app.quality_service")
    schemas = importlib.import_module("app.quality_schemas")

    async with _temporary_db(tmp_path) as db:
        _, task = await _seed(db)

        # Backward compatibility: ordinary tasks keep their existing Done path.
        await service.require_completion_authorized(db, task.id)

        contract = await service.upsert_contract(
            db,
            task.id,
            _contract_request(),
            actor="human:owner",
        )
        assert contract.revision == 1
        assert contract.stage == "plan"

        with pytest.raises(service.QualityLoopError, match="accepted evidence"):
            await service.require_completion_authorized(db, task.id)

        await service.transition_contract(
            db,
            task.id,
            schemas.QualityTransitionRequest(
                stage="execute",
                actor="executor:codex",
                reason="The implementation plan is ready.",
            ),
        )
        await service.transition_contract(
            db,
            task.id,
            schemas.QualityTransitionRequest(
                stage="verify",
                actor="executor:codex",
                reason="Implementation is ready for verification.",
            ),
        )

        receipt = await service.submit_evidence(
            db,
            task.id,
            _evidence_request(),
        )
        assert receipt.status == "submitted"

        with pytest.raises(service.QualityLoopError, match="cannot review"):
            await service.review_evidence(
                db,
                task.id,
                receipt.id,
                schemas.EvidenceReview(
                    decision="accepted",
                    reviewer="executor:codex",
                    reason="I produced it.",
                ),
            )

        reviewed = await service.review_evidence(
            db,
            task.id,
            receipt.id,
            schemas.EvidenceReview(
                decision="accepted",
                reviewer="human:owner",
                reason="I independently checked both results.",
                lesson={
                    "category": "workflow",
                    "statement": (
                        "Keep completion acceptance separate from execution."
                    ),
                },
            ),
        )
        await db.refresh(task)
        detail = await service.task_quality(db, task.id)

        assert reviewed.status == "accepted"
        assert task.is_done is True
        assert detail.contract is not None
        assert detail.contract.stage == "done"
        assert [lesson.status for lesson in detail.lessons] == ["approved"]
        await service.require_completion_authorized(db, task.id)


@pytest.mark.asyncio
async def test_rejection_returns_to_rework_and_metrics_are_durable(tmp_path):
    service = importlib.import_module("app.quality_service")
    schemas = importlib.import_module("app.quality_schemas")

    async with _temporary_db(tmp_path) as db:
        project, task = await _seed(db)
        await service.upsert_contract(
            db,
            task.id,
            _contract_request(stage="verify"),
            actor="human:owner",
        )
        receipt = await service.submit_evidence(
            db,
            task.id,
            _evidence_request(
                checks=[
                    {
                        "check_id": "completion-gate",
                        "passed": True,
                        "evidence": "gate test passed",
                    },
                    {
                        "check_id": "independent-review",
                        "passed": False,
                        "evidence": "reviewer identity was not recorded",
                    },
                ]
            ),
        )
        reviewed = await service.review_evidence(
            db,
            task.id,
            receipt.id,
            schemas.EvidenceReview(
                decision="rejected",
                reviewer="human:owner",
                reason="Independent reviewer proof is missing.",
                rework_stage="execute",
                lesson={
                    "category": "failure",
                    "statement": "Record reviewer identity before acceptance.",
                },
            ),
        )

        detail = await service.task_quality(db, task.id)
        summary = await service.project_summary(db, project.id)

        assert reviewed.status == "rejected"
        assert task.is_done is False
        assert detail.contract is not None
        assert detail.contract.stage == "execute"
        assert [lesson.status for lesson in detail.lessons] == ["approved"]
        assert summary.evidence == {
            "submitted": 0,
            "accepted": 0,
            "rejected": 1,
        }
        assert summary.acceptance_rate == 0.0
        assert summary.rework_transitions == 1


@pytest.mark.asyncio
async def test_contract_revision_invalidates_old_receipts_and_lessons_are_isolated(
    tmp_path,
):
    service = importlib.import_module("app.quality_service")

    async with _temporary_db(tmp_path) as db:
        project, task = await _seed(db)
        other_project = Project(
            id="project-other",
            name="Other",
            path="/tmp/other",
            color="#666666",
        )
        db.add(other_project)
        await db.commit()

        await service.upsert_contract(
            db,
            task.id,
            _contract_request(stage="verify"),
            actor="human:owner",
        )
        await service.submit_evidence(db, task.id, _evidence_request())
        updated = await service.upsert_contract(
            db,
            task.id,
            _contract_request(
                expected_revision=1,
                desired_outcome="Completion and re-opening both preserve authority."
            ),
            actor="human:owner",
        )

        assert updated.revision == 2
        with pytest.raises(service.QualityLoopError, match="accepted evidence"):
            await service.require_completion_authorized(db, task.id)
        assert await service.approved_lessons(db, project.id) == []
        assert await service.approved_lessons(db, other_project.id) == []


@pytest.mark.asyncio
async def test_quality_contract_update_rejects_stale_revision(tmp_path):
    service = importlib.import_module("app.quality_service")
    async with _temporary_db(tmp_path) as db:
        _, task = await _seed(db)
        await service.upsert_contract(
            db,
            task.id,
            _contract_request(),
            actor="human:owner",
        )
        with pytest.raises(service.QualityLoopError, match="changed before"):
            await service.upsert_contract(
                db,
                task.id,
                _contract_request(expected_revision=0, desired_outcome="Stale edit"),
                actor="human:owner",
            )


@pytest.mark.asyncio
async def test_submitted_receipt_cannot_be_reviewed_after_contract_left_review(
    tmp_path,
):
    service = importlib.import_module("app.quality_service")
    schemas = importlib.import_module("app.quality_schemas")

    async with _temporary_db(tmp_path) as db:
        _, task = await _seed(db)
        await service.upsert_contract(
            db,
            task.id,
            _contract_request(stage="verify"),
            actor="human:owner",
        )
        receipt = await service.submit_evidence(db, task.id, _evidence_request())
        contract = await service._contract(db, task.id)
        assert contract is not None
        contract.stage = "execute"
        await db.commit()

        with pytest.raises(service.QualityLoopError, match="only while"):
            await service.review_evidence(
                db,
                task.id,
                receipt.id,
                schemas.EvidenceReview(
                    decision="accepted",
                    reviewer="human:owner",
                    reason="Stale review attempt.",
                ),
            )


@pytest.mark.asyncio
async def test_acceptance_endpoint_archives_only_the_exact_completed_task(
    tmp_path,
    monkeypatch,
):
    main = importlib.import_module("app.main")
    service = importlib.import_module("app.quality_service")
    schemas = importlib.import_module("app.quality_schemas")

    async with _temporary_db(tmp_path) as db:
        _, task = await _seed(db)
        unrelated = Task(
            id="unrelated-task",
            project_id=task.project_id,
            title="Unrelated",
        )
        db.add(unrelated)
        await db.commit()
        await service.upsert_contract(
            db,
            task.id,
            _contract_request(stage="verify"),
            actor="human:owner",
        )
        receipt = await service.submit_evidence(db, task.id, _evidence_request())
        archived: list[str] = []

        async def record_archive(_db, task_id):
            archived.append(task_id)

        monkeypatch.setattr(
            main,
            "archive_completed_temporary_workspace",
            record_archive,
        )
        response = await main.review_task_quality_evidence(
            task.id,
            receipt.id,
            schemas.EvidenceReview(
                decision="accepted",
                reviewer="human:owner",
                reason="Independently accepted.",
            ),
            db,
        )

        assert response.contract is not None and response.contract.stage == "done"
        assert archived == [task.id]
        await db.refresh(unrelated)
        assert unrelated.is_done is False


@pytest.mark.asyncio
async def test_shared_workflow_and_public_done_paths_fail_closed(tmp_path):
    main = importlib.import_module("app.main")
    schemas = importlib.import_module("app.schemas")
    service = importlib.import_module("app.quality_service")
    workflow_service = importlib.import_module("app.task_workflow_service")

    async with _temporary_db(tmp_path) as db:
        _, task = await _seed(db)
        await service.upsert_contract(
            db,
            task.id,
            _contract_request(required_skills=["missing-quality-skill-9f41"]),
            actor="human:owner",
        )
        detail = await service.task_quality(db, task.id)
        assert detail.missing_required_skills == ["missing-quality-skill-9f41"]

        with pytest.raises(service.QualityLoopError, match="accepted evidence"):
            await workflow_service.set_task_workflow_state(db, task, "done")

        with pytest.raises(HTTPException) as update_error:
            await main.update_task(
                task.id,
                schemas.TaskUpdate(workflow_state="done"),
                db,
            )
        assert getattr(update_error.value, "status_code", None) == 409

        with pytest.raises(HTTPException) as toggle_error:
            await main.toggle_task(task.id, db)
        assert getattr(toggle_error.value, "status_code", None) == 409

        await db.refresh(task)
        assert task.is_done is False


def test_quality_routes_are_typed_and_exact():
    main = importlib.import_module("app.main")
    schemas = importlib.import_module("app.quality_schemas")
    expected = {
        (
            "/api/projects/{project_id}/quality/capabilities",
            "GET",
        ): schemas.QualityCapabilitiesResponse,
        (
            "/api/projects/{project_id}/quality/summary",
            "GET",
        ): schemas.QualitySummaryResponse,
        (
            "/api/projects/{project_id}/quality/lessons",
            "GET",
        ): schemas.OutcomeLessonListResponse,
        ("/api/tasks/{task_id}/quality", "GET"): schemas.TaskQualityResponse,
        ("/api/tasks/{task_id}/quality/contract", "PUT"): schemas.TaskQualityResponse,
        (
            "/api/tasks/{task_id}/quality/transition",
            "POST",
        ): schemas.TaskQualityResponse,
        ("/api/tasks/{task_id}/quality/evidence", "POST"): schemas.TaskQualityResponse,
        (
            "/api/tasks/{task_id}/quality/evidence/{receipt_id}/review",
            "POST",
        ): schemas.TaskQualityResponse,
    }
    observed = {}
    for route in main.app.routes:
        if not isinstance(route, APIRoute) or "/quality" not in route.path:
            continue
        for method in route.methods:
            observed[(route.path, method)] = route.response_model

    assert observed == expected


def test_skill_inventory_reads_metadata_only_and_does_not_follow_symlinks(tmp_path):
    registry = importlib.import_module("app.skill_registry")
    root = tmp_path / "skills"
    package = root / "quality-review"
    package.mkdir(parents=True)
    (package / "SKILL.md").write_text(
        "---\nname: quality-review\ndescription: Review evidence.\n---\n"
        "SECRET INSTRUCTION BODY\n",
        encoding="utf-8",
    )
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "SKILL.md").write_text(
        "---\nname: outside\ndescription: Must not load.\n---\n",
        encoding="utf-8",
    )
    (root / "escaped").symlink_to(outside, target_is_directory=True)

    result = registry.inventory_skills([registry.SkillRoot("user", root)])

    assert [(item.name, item.description) for item in result] == [
        ("quality-review", "Review evidence.")
    ]
    assert "SECRET" not in repr(result)


@pytest.mark.asyncio
async def test_owner_can_complete_contract_task_without_accepting_evidence(tmp_path):
    from app import quality_service, task_workflow_service
    from app.models import TaskQualityEvent, TaskEvidenceReceipt
    from sqlalchemy import select
    async with _temporary_db(tmp_path) as db:
        project, task = await _seed(db)
        await quality_service.upsert_contract(db, task.id, _contract_request(), actor="human:owner")
        with pytest.raises(quality_service.QualityLoopError):
            await quality_service.require_completion_authorized(db, task.id)
        from app.main import owner_task_completion
        from app.schemas import OwnerTaskCompletion
        response = await owner_task_completion(task.id, OwnerTaskCompletion(is_done=True), db)
        assert response.is_done is True
        await db.commit()
        assert task.is_done and task.completed_at is not None
        assert (await task_workflow_service.get_or_create_workflow(db, task)).state == 'done'
        assert not list((await db.scalars(select(TaskEvidenceReceipt))).all())
        event = await db.scalar(select(TaskQualityEvent).where(TaskQualityEvent.kind == 'owner_completion'))
        assert event.actor == 'human:owner'
        await task_workflow_service.set_owner_task_completion(db, task, False)
        assert not task.is_done and task.completed_at is None
        with pytest.raises(quality_service.QualityLoopError):
            await quality_service.require_completion_authorized(db, task.id)
