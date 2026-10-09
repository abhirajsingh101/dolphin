from __future__ import annotations

from datetime import datetime
from typing import Literal
import unicodedata

from pydantic import BaseModel, Field, field_validator, model_validator

QualityStage = Literal[
    "discover", "specify", "plan", "execute", "verify", "review", "done"
]
RiskLevel = Literal["low", "medium", "high", "critical"]
LessonCategory = Literal["success", "failure", "correction", "workflow"]


def _safe_quality_text(value: str, *, field: str) -> str:
    normalized = value.strip()
    if not normalized:
        raise ValueError(f"{field} must not be blank")
    if any(
        character == "\x1b" or unicodedata.category(character).startswith("C")
        for character in normalized
    ):
        raise ValueError(f"{field} contains unsafe control text")
    return normalized


class AcceptanceCheck(BaseModel):
    id: str = Field(min_length=1, max_length=80, pattern=r"^[a-z0-9][a-z0-9_-]*$")
    description: str = Field(min_length=1, max_length=500)

    @field_validator("id")
    @classmethod
    def _trim_id(cls, value: str) -> str:
        return _safe_quality_text(value, field="acceptance check id")

    @field_validator("description")
    @classmethod
    def _trim_description(cls, value: str) -> str:
        return _safe_quality_text(value, field="observable evidence")


class EvidenceCheck(BaseModel):
    check_id: str = Field(min_length=1, max_length=80)
    passed: bool
    evidence: str = Field(min_length=1, max_length=2_000)

    @field_validator("check_id", "evidence")
    @classmethod
    def _trim(cls, value: str) -> str:
        return _safe_quality_text(value, field="evidence check")


class QualityContractUpsert(BaseModel):
    expected_revision: int = Field(default=0, ge=0)
    desired_outcome: str = Field(min_length=1, max_length=2_000)
    risk_level: RiskLevel = "medium"
    stage: QualityStage = "plan"
    acceptance_checks: list[AcceptanceCheck] = Field(min_length=1, max_length=20)
    required_skills: list[str] = Field(default_factory=list, max_length=20)
    human_review_required: Literal[True] = True

    @field_validator("desired_outcome")
    @classmethod
    def _trim_outcome(cls, value: str) -> str:
        return _safe_quality_text(value, field="desired outcome")

    @field_validator("required_skills")
    @classmethod
    def _skills(cls, values: list[str]) -> list[str]:
        trimmed = [
            _safe_quality_text(value, field="required skill") for value in values
        ]
        if any(len(value) > 120 for value in trimmed):
            raise ValueError("required skill names must contain 1-120 characters")
        if len({value.casefold() for value in trimmed}) != len(trimmed):
            raise ValueError("required skill names must be unique")
        return trimmed

    @model_validator(mode="after")
    def _unique_checks(self):
        ids = [item.id for item in self.acceptance_checks]
        if len(ids) != len(set(ids)):
            raise ValueError("acceptance check ids must be unique")
        if self.stage in {"review", "done"}:
            raise ValueError(
                "only submitted or accepted evidence may set the stage to review or done"
            )
        return self


class QualityTransitionRequest(BaseModel):
    stage: QualityStage
    actor: str = Field(min_length=1, max_length=120)
    reason: str = Field(min_length=1, max_length=1_000)

    @field_validator("actor", "reason")
    @classmethod
    def _trim(cls, value: str) -> str:
        return _safe_quality_text(value, field="quality transition")


class EvidenceSubmit(BaseModel):
    contract_revision: int = Field(ge=1)
    producer: str = Field(min_length=1, max_length=120)
    summary: str = Field(min_length=1, max_length=2_000)
    checks: list[EvidenceCheck] = Field(min_length=1, max_length=20)

    @field_validator("producer", "summary")
    @classmethod
    def _trim(cls, value: str) -> str:
        return _safe_quality_text(value, field="evidence")

    @model_validator(mode="after")
    def _unique_checks(self):
        ids = [item.check_id for item in self.checks]
        if len(ids) != len(set(ids)):
            raise ValueError("evidence check ids must be unique")
        return self


class OutcomeLessonCreate(BaseModel):
    category: LessonCategory
    statement: str = Field(min_length=1, max_length=500)

    @field_validator("statement")
    @classmethod
    def _trim(cls, value: str) -> str:
        return _safe_quality_text(value, field="outcome lesson")


class EvidenceReview(BaseModel):
    decision: Literal["accepted", "rejected"]
    reviewer: str = Field(min_length=1, max_length=120)
    reason: str = Field(min_length=1, max_length=2_000)
    rework_stage: Literal["execute", "verify"] = "execute"
    lesson: OutcomeLessonCreate | None = None

    @field_validator("reviewer", "reason")
    @classmethod
    def _trim(cls, value: str) -> str:
        return _safe_quality_text(value, field="evidence review")


class QualityContractResponse(BaseModel):
    task_id: str
    project_id: str
    desired_outcome: str
    risk_level: RiskLevel
    stage: QualityStage
    acceptance_checks: list[AcceptanceCheck]
    required_skills: list[str]
    human_review_required: bool
    revision: int
    created_at: datetime
    updated_at: datetime


class EvidenceReceiptResponse(BaseModel):
    id: str
    task_id: str
    project_id: str
    contract_revision: int
    producer: str
    summary: str
    checks: list[EvidenceCheck]
    status: Literal["submitted", "accepted", "rejected"]
    reviewer: str | None = None
    review_reason: str | None = None
    submitted_at: datetime
    reviewed_at: datetime | None = None


class OutcomeLessonResponse(BaseModel):
    id: str
    project_id: str
    task_id: str
    receipt_id: str
    category: LessonCategory
    statement: str
    status: Literal["proposed", "approved", "rejected", "superseded"]
    decided_by: str | None = None
    created_at: datetime
    decided_at: datetime | None = None


class SkillCapability(BaseModel):
    name: str
    description: str
    source: str


class QualityCapabilitiesResponse(BaseModel):
    project_id: str
    skills: list[SkillCapability]


class TaskQualityResponse(BaseModel):
    task_id: str
    project_id: str
    contract: QualityContractResponse | None = None
    receipts: list[EvidenceReceiptResponse] = Field(default_factory=list)
    lessons: list[OutcomeLessonResponse] = Field(default_factory=list)
    available_skills: list[SkillCapability] = Field(default_factory=list)
    missing_required_skills: list[str] = Field(default_factory=list)


class OutcomeLessonListResponse(BaseModel):
    project_id: str
    lessons: list[OutcomeLessonResponse]


class QualitySummaryResponse(BaseModel):
    project_id: str
    contracts_by_stage: dict[str, int]
    contracts_by_risk: dict[str, int]
    evidence: dict[str, int]
    acceptance_rate: float | None
    awaiting_review: int
    approved_lessons: int
    rework_transitions: int
