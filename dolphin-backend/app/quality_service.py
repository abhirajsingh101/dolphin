from __future__ import annotations

import json
from datetime import datetime, timezone

from sqlalchemy import select, update as sql_update
from sqlalchemy.ext.asyncio import AsyncSession

from .models import (
    Project,
    Task,
    TaskEvidenceReceipt,
    TaskOutcomeLesson,
    TaskQualityContract,
    TaskQualityEvent,
)
from .quality_schemas import (
    AcceptanceCheck,
    EvidenceCheck,
    EvidenceReceiptResponse,
    EvidenceReview,
    EvidenceSubmit,
    OutcomeLessonListResponse,
    OutcomeLessonResponse,
    QualityCapabilitiesResponse,
    QualityContractResponse,
    QualityContractUpsert,
    QualitySummaryResponse,
    QualityTransitionRequest,
    TaskQualityResponse,
)
from .skill_registry import project_capabilities
from .task_workflow_service import set_task_workflow_state

STAGES = ("discover", "specify", "plan", "execute", "verify", "review", "done")
RISKS = ("low", "medium", "high", "critical")
RECEIPT_STATES = ("submitted", "accepted", "rejected")
_FORWARD = {
    "discover": {"specify"},
    "specify": {"plan", "discover"},
    "plan": {"execute", "specify"},
    "execute": {"verify", "plan"},
    "verify": {"review", "execute", "plan"},
    "review": {"verify", "execute"},
    "done": set(),
}


class QualityLoopError(RuntimeError):
    def __init__(self, detail: str, status_code: int = 409):
        super().__init__(detail)
        self.detail = detail
        self.status_code = status_code


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _dump(value) -> str:
    return json.dumps(value, ensure_ascii=True, separators=(",", ":"))


def _load(value: str) -> list:
    loaded = json.loads(value)
    return loaded if isinstance(loaded, list) else []


async def _task(db: AsyncSession, task_id: str) -> Task:
    task = await db.get(Task, task_id)
    if task is None:
        raise QualityLoopError("Task not found.", 404)
    return task


async def _project(db: AsyncSession, project_id: str) -> Project:
    project = await db.get(Project, project_id)
    if project is None:
        raise QualityLoopError("Project not found.", 404)
    return project


async def _contract(
    db: AsyncSession,
    task_id: str,
    *,
    required: bool = True,
) -> TaskQualityContract | None:
    contract = await db.get(TaskQualityContract, task_id)
    if contract is None and required:
        raise QualityLoopError("This task has no Quality Contract.", 404)
    return contract


def _contract_response(contract: TaskQualityContract) -> QualityContractResponse:
    return QualityContractResponse(
        task_id=contract.task_id,
        project_id=contract.project_id,
        desired_outcome=contract.desired_outcome,
        risk_level=contract.risk_level,
        stage=contract.stage,
        acceptance_checks=[
            AcceptanceCheck.model_validate(item)
            for item in _load(contract.acceptance_checks_json)
        ],
        required_skills=[str(item) for item in _load(contract.required_skills_json)],
        human_review_required=contract.human_review_required,
        revision=contract.revision,
        created_at=contract.created_at,
        updated_at=contract.updated_at,
    )

def _receipt_response(receipt: TaskEvidenceReceipt) -> EvidenceReceiptResponse:
    return EvidenceReceiptResponse(
        id=receipt.id,
        task_id=receipt.task_id,
        project_id=receipt.project_id,
        contract_revision=receipt.contract_revision,
        producer=receipt.producer,
        summary=receipt.summary,
        checks=[
            EvidenceCheck.model_validate(item) for item in _load(receipt.checks_json)
        ],
        status=receipt.status,
        reviewer=receipt.reviewer,
        review_reason=receipt.review_reason,
        submitted_at=receipt.submitted_at,
        reviewed_at=receipt.reviewed_at,
    )


def _lesson_response(lesson: TaskOutcomeLesson) -> OutcomeLessonResponse:
    return OutcomeLessonResponse(
        id=lesson.id,
        project_id=lesson.project_id,
        task_id=lesson.task_id,
        receipt_id=lesson.receipt_id,
        category=lesson.category,
        statement=lesson.statement,
        status=lesson.status,
        decided_by=lesson.decided_by,
        created_at=lesson.created_at,
        decided_at=lesson.decided_at,
    )


def _event(
    *,
    contract: TaskQualityContract,
    kind: str,
    actor: str,
    from_stage: str | None = None,
    to_stage: str | None = None,
    reason: str | None = None,
    receipt_id: str | None = None,
) -> TaskQualityEvent:
    return TaskQualityEvent(
        project_id=contract.project_id,
        task_id=contract.task_id,
        contract_revision=contract.revision,
        kind=kind,
        actor=actor,
        from_stage=from_stage,
        to_stage=to_stage,
        reason=reason,
        receipt_id=receipt_id,
    )


async def upsert_contract(
    db: AsyncSession,
    task_id: str,
    data: QualityContractUpsert,
    *,
    actor: str,
    commit: bool = True,
) -> QualityContractResponse:
    task = await _task(db, task_id)
    existing = await _contract(db, task_id, required=False)
    now = _now()
    checks_json = _dump([item.model_dump() for item in data.acceptance_checks])
    skills_json = _dump(data.required_skills)
    if existing is None:
        if data.expected_revision != 0:
            raise QualityLoopError(
                "Quality Contract changed before it was saved. Reload its current revision."
            )
        if task.is_done:
            raise QualityLoopError("Reopen this task before adding a Quality Contract.")
        contract = TaskQualityContract(
            task_id=task.id,
            project_id=task.project_id,
            desired_outcome=data.desired_outcome,
            risk_level=data.risk_level,
            stage=data.stage,
            acceptance_checks_json=checks_json,
            required_skills_json=skills_json,
            human_review_required=data.human_review_required,
            revision=1,
            created_at=now,
            updated_at=now,
        )
        db.add(contract)
        await db.flush()
        db.add(
            _event(
                contract=contract,
                kind="contract_created",
                actor=actor,
                to_stage=data.stage,
            )
        )
    else:
        if data.expected_revision != existing.revision:
            raise QualityLoopError(
                "Quality Contract changed before it was saved. Reload its current revision."
            )
        if existing.stage == "done" or task.is_done:
            await set_task_workflow_state(db, task, "todo")
        previous_stage = existing.stage
        claimed = await db.execute(
            sql_update(TaskQualityContract)
            .where(
                TaskQualityContract.task_id == task_id,
                TaskQualityContract.revision == data.expected_revision,
            )
            .values(
                desired_outcome=data.desired_outcome,
                risk_level=data.risk_level,
                stage=data.stage,
                acceptance_checks_json=checks_json,
                required_skills_json=skills_json,
                human_review_required=True,
                revision=data.expected_revision + 1,
                updated_at=now,
            )
            .execution_options(synchronize_session=False)
        )
        if claimed.rowcount != 1:
            await db.rollback()
            raise QualityLoopError(
                "Quality Contract changed before it was saved. Reload its current revision."
            )
        await db.refresh(existing)
        contract = existing
        db.add(
            _event(
                contract=contract,
                kind="contract_updated",
                actor=actor,
                from_stage=previous_stage,
                to_stage=data.stage,
            )
        )
    if commit:
        await db.commit()
        await db.refresh(contract)
    else:
        await db.flush()
    return _contract_response(contract)


async def transition_contract(
    db: AsyncSession,
    task_id: str,
    data: QualityTransitionRequest,
) -> QualityContractResponse:
    await _task(db, task_id)
    contract = await _contract(db, task_id)
    assert contract is not None
    if data.stage == "done":
        raise QualityLoopError("Only accepted evidence may set the stage to done.")
    if data.stage == "review":
        raise QualityLoopError(
            "Only a submitted evidence receipt may enter the review stage."
        )
    if data.stage == contract.stage:
        return _contract_response(contract)
    if data.stage not in _FORWARD[contract.stage]:
        raise QualityLoopError(
            f"Quality stage cannot move from {contract.stage} to {data.stage}."
        )
    previous = contract.stage
    contract.stage = data.stage
    contract.updated_at = _now()
    quality_event = _event(
        contract=contract,
        kind="stage_transitioned",
        actor=data.actor,
        from_stage=previous,
        to_stage=data.stage,
        reason=data.reason,
    )
    db.add(quality_event)
    await db.commit()
    await db.refresh(contract)
    return _contract_response(contract)


async def submit_evidence(
    db: AsyncSession,
    task_id: str,
    data: EvidenceSubmit,
) -> EvidenceReceiptResponse:
    await _task(db, task_id)
    contract = await _contract(db, task_id)
    assert contract is not None
    if contract.stage != "verify":
        raise QualityLoopError("Evidence may only be submitted in the verify stage.")
    if data.contract_revision != contract.revision:
        raise QualityLoopError("Evidence targets a stale Quality Contract revision.")
    expected_ids = {item["id"] for item in _load(contract.acceptance_checks_json)}
    observed_ids = {item.check_id for item in data.checks}
    if observed_ids != expected_ids:
        missing = sorted(expected_ids - observed_ids)
        extra = sorted(observed_ids - expected_ids)
        raise QualityLoopError(
            "Evidence must cover every acceptance check exactly; "
            f"missing={missing}, unknown={extra}."
        )
    previous = contract.stage
    contract.stage = "review"
    contract.updated_at = _now()
    receipt = TaskEvidenceReceipt(
        task_id=contract.task_id,
        project_id=contract.project_id,
        contract_revision=contract.revision,
        producer=data.producer,
        summary=data.summary,
        checks_json=_dump([item.model_dump() for item in data.checks]),
        status="submitted",
    )
    db.add(receipt)
    await db.flush()
    quality_event = _event(
        contract=contract,
        kind="evidence_submitted",
        actor=data.producer,
        from_stage=previous,
        to_stage="review",
        receipt_id=receipt.id,
    )
    db.add(quality_event)
    await db.commit()
    await db.refresh(receipt)
    return _receipt_response(receipt)


async def review_evidence(
    db: AsyncSession,
    task_id: str,
    receipt_id: str,
    data: EvidenceReview,
    *,
    commit: bool = True,
) -> EvidenceReceiptResponse:
    task = await _task(db, task_id)
    contract = await _contract(db, task_id)
    receipt = await db.get(TaskEvidenceReceipt, receipt_id)
    assert contract is not None
    if receipt is None or receipt.task_id != task_id:
        raise QualityLoopError("Evidence receipt not found.", 404)
    if receipt.status != "submitted":
        raise QualityLoopError("This evidence receipt already has a review decision.")
    if contract.stage != "review":
        raise QualityLoopError(
            "Evidence can be reviewed only while its contract is in review."
        )
    if receipt.producer.casefold() == data.reviewer.casefold():
        raise QualityLoopError("The evidence producer cannot review its own receipt.")
    if receipt.contract_revision != contract.revision:
        raise QualityLoopError(
            "This evidence receipt targets a stale contract revision."
        )
    now = _now()
    if data.decision == "accepted":
        checks = _load(receipt.checks_json)
        if not checks or not all(item.get("passed") is True for item in checks):
            raise QualityLoopError("Failed acceptance checks cannot be accepted.")
    claimed = await db.execute(
        sql_update(TaskEvidenceReceipt)
        .where(
            TaskEvidenceReceipt.id == receipt.id,
            TaskEvidenceReceipt.status == "submitted",
            TaskEvidenceReceipt.contract_revision == contract.revision,
        )
        .values(
            status=data.decision,
            reviewer=data.reviewer,
            review_reason=data.reason,
            reviewed_at=now,
        )
        .execution_options(synchronize_session=False)
    )
    if claimed.rowcount != 1:
        await db.rollback()
        raise QualityLoopError("This evidence receipt already has a review decision.")
    previous = contract.stage
    if data.decision == "accepted":
        contract.stage = "done"
    else:
        contract.stage = data.rework_stage
    contract.updated_at = now
    quality_event = _event(
        contract=contract,
        kind=f"evidence_{data.decision}",
        actor=data.reviewer,
        from_stage=previous,
        to_stage=contract.stage,
        reason=data.reason,
        receipt_id=receipt.id,
    )
    db.add(quality_event)
    await set_task_workflow_state(
        db,
        task,
        "done" if data.decision == "accepted" else "in_progress",
    )
    if data.lesson is not None:
        db.add(
            TaskOutcomeLesson(
                project_id=task.project_id,
                task_id=task.id,
                receipt_id=receipt.id,
                category=data.lesson.category,
                statement=data.lesson.statement,
                status="approved",
                decided_by=data.reviewer,
                decided_at=now,
            )
        )
    if commit:
        await db.commit()
    else:
        await db.flush()
    await db.refresh(receipt)
    return _receipt_response(receipt)


async def require_completion_authorized(
    db: AsyncSession,
    task_id: str,
) -> str | None:
    await _task(db, task_id)
    contract = await _contract(db, task_id, required=False)
    if contract is None:
        return None
    accepted_ids = list(
        (
            await db.scalars(
                select(TaskEvidenceReceipt.id)
                .where(
                    TaskEvidenceReceipt.task_id == task_id,
                    TaskEvidenceReceipt.contract_revision == contract.revision,
                    TaskEvidenceReceipt.status == "accepted",
                )
                .order_by(TaskEvidenceReceipt.id)
                .limit(2)
            )
        ).all()
    )
    if not accepted_ids:
        raise QualityLoopError(
            "This task has a Quality Contract and needs accepted evidence "
            "before it can become Done."
        )
    return str(accepted_ids[0])


async def approved_lessons(
    db: AsyncSession,
    project_id: str,
) -> list[OutcomeLessonResponse]:
    await _project(db, project_id)
    result = await db.scalars(
        select(TaskOutcomeLesson)
        .where(
            TaskOutcomeLesson.project_id == project_id,
            TaskOutcomeLesson.status == "approved",
        )
        .order_by(TaskOutcomeLesson.created_at.desc(), TaskOutcomeLesson.id.desc())
        .limit(50)
    )
    return [_lesson_response(item) for item in result.all()]


async def capabilities(
    db: AsyncSession,
    project_id: str,
) -> QualityCapabilitiesResponse:
    project = await _project(db, project_id)
    return QualityCapabilitiesResponse(
        project_id=project.id,
        skills=project_capabilities(project.path),
    )


async def task_quality(db: AsyncSession, task_id: str) -> TaskQualityResponse:
    task = await _task(db, task_id)
    contract = await _contract(db, task_id, required=False)
    receipt_rows = await db.scalars(
        select(TaskEvidenceReceipt)
        .where(TaskEvidenceReceipt.task_id == task_id)
        .order_by(
            TaskEvidenceReceipt.submitted_at.desc(),
            TaskEvidenceReceipt.id.desc(),
        )
    )
    lesson_rows = await db.scalars(
        select(TaskOutcomeLesson)
        .where(TaskOutcomeLesson.task_id == task_id)
        .order_by(TaskOutcomeLesson.created_at.desc(), TaskOutcomeLesson.id.desc())
    )
    project = await _project(db, task.project_id)
    available = project_capabilities(project.path)
    available_names = {item.name.casefold() for item in available}
    required = (
        [str(item) for item in _load(contract.required_skills_json)]
        if contract is not None
        else []
    )
    missing = [item for item in required if item.casefold() not in available_names]
    return TaskQualityResponse(
        task_id=task.id,
        project_id=task.project_id,
        contract=_contract_response(contract) if contract is not None else None,
        receipts=[_receipt_response(item) for item in receipt_rows.all()],
        lessons=[_lesson_response(item) for item in lesson_rows.all()],
        available_skills=available,
        missing_required_skills=missing,
    )


async def project_summary(
    db: AsyncSession,
    project_id: str,
) -> QualitySummaryResponse:
    await _project(db, project_id)
    contracts = list(
        (
            await db.scalars(
                select(TaskQualityContract).where(
                    TaskQualityContract.project_id == project_id
                )
            )
        ).all()
    )
    receipts = list(
        (
            await db.scalars(
                select(TaskEvidenceReceipt).where(
                    TaskEvidenceReceipt.project_id == project_id
                )
            )
        ).all()
    )
    lessons = list(
        (
            await db.scalars(
                select(TaskOutcomeLesson).where(
                    TaskOutcomeLesson.project_id == project_id,
                    TaskOutcomeLesson.status == "approved",
                )
            )
        ).all()
    )
    events = list(
        (
            await db.scalars(
                select(TaskQualityEvent).where(
                    TaskQualityEvent.project_id == project_id,
                    TaskQualityEvent.kind == "evidence_rejected",
                )
            )
        ).all()
    )
    stage_counts = {stage: 0 for stage in STAGES}
    risk_counts = {risk: 0 for risk in RISKS}
    evidence_counts = {state: 0 for state in RECEIPT_STATES}
    for contract in contracts:
        stage_counts[contract.stage] += 1
        risk_counts[contract.risk_level] += 1
    for receipt in receipts:
        evidence_counts[receipt.status] += 1
    decisions = evidence_counts["accepted"] + evidence_counts["rejected"]
    rate = round(evidence_counts["accepted"] / decisions, 4) if decisions else None
    return QualitySummaryResponse(
        project_id=project_id,
        contracts_by_stage=stage_counts,
        contracts_by_risk=risk_counts,
        evidence=evidence_counts,
        acceptance_rate=rate,
        awaiting_review=sum(item.stage == "review" for item in contracts),
        approved_lessons=len(lessons),
        rework_transitions=len(events),
    )


async def project_lessons(
    db: AsyncSession,
    project_id: str,
) -> OutcomeLessonListResponse:
    return OutcomeLessonListResponse(
        project_id=project_id,
        lessons=await approved_lessons(db, project_id),
    )
