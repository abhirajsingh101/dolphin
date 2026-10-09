import secrets
import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    Boolean,
    Float,
    CheckConstraint,
    Column,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    String,
    Text,
    Time,
    UniqueConstraint,
)
from sqlalchemy.orm import relationship

from .database import Base


def generate_id():
    return uuid.uuid4().hex


def generate_run_id():
    """Unguessable because it appears in the hook callback URL (spec §8.4)."""
    return secrets.token_urlsafe(24)


def utcnow():
    return datetime.now(timezone.utc)


class Project(Base):
    __tablename__ = "projects"

    id = Column(String, primary_key=True, default=generate_id)
    name = Column(String, nullable=False)
    emoji = Column(String, default="")
    color = Column(String, default="#6B7280")
    path = Column(String, nullable=True)
    is_inbox = Column(Boolean, default=False)
    position = Column(Integer, default=0)
    serial_queue_id = Column(String, nullable=True, index=True)
    serial_queue_status = Column(
        String,
        default="idle",
        server_default="idle",
        nullable=False,
    )
    serial_queue_session_name = Column(String, nullable=True)
    serial_queue_error = Column(Text, nullable=True)
    serial_queue_created_at = Column(DateTime, nullable=True)
    serial_queue_updated_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=utcnow)
    updated_at = Column(DateTime, default=utcnow, onupdate=utcnow)

    sections = relationship("Section", back_populates="project", cascade="all, delete-orphan")
    tasks = relationship("Task", back_populates="project", cascade="all, delete-orphan")
    research_binding = relationship(
        "ResearchBinding",
        back_populates="project",
        cascade="all, delete-orphan",
        uselist=False,
    )
    quality_contracts = relationship(
        "TaskQualityContract",
        back_populates="project",
        cascade="all, delete-orphan",
    )
    quality_receipts = relationship(
        "TaskEvidenceReceipt",
        back_populates="project",
        cascade="all, delete-orphan",
    )
    quality_lessons = relationship(
        "TaskOutcomeLesson",
        back_populates="project",
        cascade="all, delete-orphan",
    )
    quality_events = relationship(
        "TaskQualityEvent",
        back_populates="project",
        cascade="all, delete-orphan",
    )


class ResearchBinding(Base):
    """Explicit opt-in link to an already-existing Research OS instance."""

    __tablename__ = "research_bindings"

    id = Column(String, primary_key=True, default=generate_id)
    project_id = Column(
        String,
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
        unique=True,
        index=True,
    )
    instance_id = Column(String, nullable=False, unique=True, index=True)
    created_at = Column(DateTime, default=utcnow)
    updated_at = Column(DateTime, default=utcnow, onupdate=utcnow)

    project = relationship("Project", back_populates="research_binding")


class Section(Base):
    __tablename__ = "sections"

    id = Column(String, primary_key=True, default=generate_id)
    project_id = Column(String, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    name = Column(String, nullable=False)
    position = Column(Integer, default=0)
    is_collapsed = Column(Boolean, default=False)
    created_at = Column(DateTime, default=utcnow)

    project = relationship("Project", back_populates="sections")
    tasks = relationship("Task", back_populates="section")


class Task(Base):
    __tablename__ = "tasks"

    id = Column(String, primary_key=True, default=generate_id)
    project_id = Column(String, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    section_id = Column(String, ForeignKey("sections.id", ondelete="SET NULL"), nullable=True)
    title = Column(String, nullable=False)
    description = Column(Text, default="")
    priority = Column(Integer, default=4)
    due_date = Column(Date, nullable=True)
    due_time = Column(Time, nullable=True)
    is_done = Column(Boolean, default=False)
    position = Column(Integer, default=0)
    origin = Column(String, default="human", server_default="human", nullable=False)
    execution_prompt = Column(Text, default="", server_default="", nullable=False)
    created_at = Column(DateTime, default=utcnow)
    updated_at = Column(DateTime, default=utcnow, onupdate=utcnow)
    completed_at = Column(DateTime, nullable=True)

    project = relationship("Project", back_populates="tasks")
    section = relationship("Section", back_populates="tasks")
    labels = relationship("Label", secondary="task_labels", back_populates="tasks")
    workflow = relationship(
        "TaskWorkflow",
        back_populates="task",
        cascade="all, delete-orphan",
        uselist=False,
    )
    quality_contract = relationship(
        "TaskQualityContract",
        back_populates="task",
        cascade="all, delete-orphan",
        uselist=False,
    )
    evidence_receipts = relationship(
        "TaskEvidenceReceipt",
        back_populates="task",
        cascade="all, delete-orphan",
    )
    outcome_lessons = relationship(
        "TaskOutcomeLesson",
        back_populates="task",
        cascade="all, delete-orphan",
    )
    quality_events = relationship(
        "TaskQualityEvent",
        back_populates="task",
        cascade="all, delete-orphan",
    )


class TaskQualityContract(Base):
    """The versioned quality boundary for one exact task."""

    __tablename__ = "task_quality_contracts"
    __table_args__ = (
        CheckConstraint(
            "risk_level IN ('low', 'medium', 'high', 'critical')",
            name="ck_task_quality_contract_risk",
        ),
        CheckConstraint(
            "stage IN ('discover', 'specify', 'plan', 'execute', "
            "'verify', 'review', 'done')",
            name="ck_task_quality_contract_stage",
        ),
    )

    task_id = Column(
        String,
        ForeignKey("tasks.id", ondelete="CASCADE"),
        primary_key=True,
    )
    project_id = Column(
        String,
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    desired_outcome = Column(Text, nullable=False)
    risk_level = Column(String, nullable=False, default="medium")
    stage = Column(String, nullable=False, default="plan")
    acceptance_checks_json = Column(Text, nullable=False, default="[]")
    required_skills_json = Column(Text, nullable=False, default="[]")
    human_review_required = Column(Boolean, nullable=False, default=True)
    revision = Column(Integer, nullable=False, default=1)
    created_at = Column(DateTime, nullable=False, default=utcnow)
    updated_at = Column(DateTime, nullable=False, default=utcnow, onupdate=utcnow)

    task = relationship("Task", back_populates="quality_contract")
    project = relationship("Project", back_populates="quality_contracts")


class TaskEvidenceReceipt(Base):
    """Immutable executor evidence with one independent review decision."""

    __tablename__ = "task_evidence_receipts"
    __table_args__ = (
        CheckConstraint(
            "status IN ('submitted', 'accepted', 'rejected')",
            name="ck_task_evidence_receipt_status",
        ),
        Index("ix_task_evidence_task_revision", "task_id", "contract_revision"),
    )

    id = Column(String, primary_key=True, default=generate_id)
    task_id = Column(
        String,
        ForeignKey("tasks.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    project_id = Column(
        String,
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    contract_revision = Column(Integer, nullable=False)
    producer = Column(String, nullable=False)
    summary = Column(Text, nullable=False)
    checks_json = Column(Text, nullable=False, default="[]")
    status = Column(String, nullable=False, default="submitted")
    reviewer = Column(String, nullable=True)
    review_reason = Column(Text, nullable=True)
    submitted_at = Column(DateTime, nullable=False, default=utcnow)
    reviewed_at = Column(DateTime, nullable=True)

    task = relationship("Task", back_populates="evidence_receipts")
    project = relationship("Project", back_populates="quality_receipts")


class TaskOutcomeLesson(Base):
    """A provenance-bound outcome lesson, never an instruction or work source."""

    __tablename__ = "task_outcome_lessons"
    __table_args__ = (
        CheckConstraint(
            "category IN ('success', 'failure', 'correction', 'workflow')",
            name="ck_task_outcome_lesson_category",
        ),
        CheckConstraint(
            "status IN ('proposed', 'approved', 'rejected', 'superseded')",
            name="ck_task_outcome_lesson_status",
        ),
        UniqueConstraint("receipt_id", name="uq_task_outcome_lesson_receipt"),
    )

    id = Column(String, primary_key=True, default=generate_id)
    project_id = Column(
        String,
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    task_id = Column(
        String,
        ForeignKey("tasks.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    receipt_id = Column(
        String,
        ForeignKey("task_evidence_receipts.id", ondelete="CASCADE"),
        nullable=False,
    )
    category = Column(String, nullable=False)
    statement = Column(Text, nullable=False)
    status = Column(String, nullable=False, default="proposed")
    decided_by = Column(String, nullable=True)
    created_at = Column(DateTime, nullable=False, default=utcnow)
    decided_at = Column(DateTime, nullable=True)

    task = relationship("Task", back_populates="outcome_lessons")
    project = relationship("Project", back_populates="quality_lessons")
    receipt = relationship("TaskEvidenceReceipt")


class TaskQualityEvent(Base):
    """Append-only audit event for the task quality state machine."""

    __tablename__ = "task_quality_events"
    __table_args__ = (
        Index("ix_task_quality_event_task_created", "task_id", "created_at"),
    )

    id = Column(String, primary_key=True, default=generate_id)
    project_id = Column(
        String,
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    task_id = Column(
        String,
        ForeignKey("tasks.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    contract_revision = Column(Integer, nullable=False)
    kind = Column(String, nullable=False)
    from_stage = Column(String, nullable=True)
    to_stage = Column(String, nullable=True)
    actor = Column(String, nullable=False)
    reason = Column(Text, nullable=True)
    receipt_id = Column(String, nullable=True)
    created_at = Column(DateTime, nullable=False, default=utcnow)

    task = relationship("Task", back_populates="quality_events")
    project = relationship("Project", back_populates="quality_events")


class TaskWorkflow(Base):
    """Durable Kanban and research-run state for one task.

    This intentionally lives beside the legacy task row so existing databases can
    gain the workflow with an additive CREATE TABLE migration.
    """

    __tablename__ = "task_workflows"

    task_id = Column(
        String,
        ForeignKey("tasks.id", ondelete="CASCADE"),
        primary_key=True,
    )
    state = Column(String, default="todo", nullable=False)
    session_name = Column(String, nullable=True, unique=True)
    research_status = Column(String, default="idle", nullable=False)
    launch_error = Column(Text, nullable=True)
    research_brief = Column(Text, default="", nullable=False)
    prompt_sent_at = Column(DateTime, nullable=True)
    started_at = Column(DateTime, nullable=True)
    research_completed_at = Column(DateTime, nullable=True)
    placement_kind = Column(String, nullable=True)
    placement_project_id = Column(String, nullable=True)
    placement_project_name = Column(String, nullable=True)
    placement_workspace_path = Column(Text, nullable=True)
    placement_reason = Column(Text, nullable=True)
    placement_confidence = Column(Integer, nullable=True)
    placement_generated_at = Column(DateTime, nullable=True)
    source_project_id = Column(String, nullable=True)
    cleanup_status = Column(
        String,
        default="not_applicable",
        server_default="not_applicable",
        nullable=False,
    )
    cleanup_error = Column(Text, nullable=True)
    cleanup_archive_path = Column(Text, nullable=True)
    cleanup_completed_at = Column(DateTime, nullable=True)
    serial_queue_id = Column(String, nullable=True, index=True)
    serial_queue_position = Column(Integer, nullable=True)
    serial_queue_status = Column(
        String,
        default="not_queued",
        server_default="not_queued",
        nullable=False,
    )
    serial_queue_error = Column(Text, nullable=True)
    serial_queue_enqueued_at = Column(DateTime, nullable=True)
    serial_queue_started_at = Column(DateTime, nullable=True)
    serial_queue_completed_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=utcnow, nullable=False)
    updated_at = Column(DateTime, default=utcnow, onupdate=utcnow, nullable=False)

    task = relationship("Task", back_populates="workflow")


class Label(Base):
    __tablename__ = "labels"

    id = Column(String, primary_key=True, default=generate_id)
    name = Column(String, nullable=False, unique=True)
    color = Column(String, default="#6B7280")
    position = Column(Integer, default=0)

    tasks = relationship("Task", secondary="task_labels", back_populates="labels")


class TaskLabel(Base):
    __tablename__ = "task_labels"

    task_id = Column(String, ForeignKey("tasks.id", ondelete="CASCADE"), primary_key=True)
    label_id = Column(String, ForeignKey("labels.id", ondelete="CASCADE"), primary_key=True)


class Run(Base):
    """One agent dispatch, append-only.

    Separate from TaskWorkflow on purpose: TaskWorkflow is one row per TASK and
    records what the operator decided, so a retry would overwrite the only
    evidence the first attempt happened. A run records what actually occurred.
    """

    __tablename__ = "runs"

    id = Column(String, primary_key=True, default=generate_run_id)
    task_id = Column(
        String, ForeignKey("tasks.id", ondelete="CASCADE"), nullable=False, index=True
    )
    project_id = Column(String, ForeignKey("projects.id"), nullable=False)
    # Deliberately NOT unique: TaskWorkflow.session_name already carries the
    # unique durable-session constraint, and several runs over a task's life
    # legitimately share one session.
    session_name = Column(String, nullable=False, index=True)
    agent = Column(String, nullable=False)
    workspace_path = Column(Text, nullable=False)
    state = Column(String, default="dispatched", server_default="dispatched", nullable=False, index=True)
    dispatched_at = Column(DateTime, default=utcnow, nullable=False)
    started_at = Column(DateTime, nullable=True)
    ended_at = Column(DateTime, nullable=True)
    last_event_at = Column(DateTime, nullable=True)
    turn_count = Column(Integer, default=0, server_default="0", nullable=False)
    receipt_path = Column(Text, nullable=True)
    error = Column(Text, nullable=True)
    created_at = Column(DateTime, default=utcnow, nullable=False)
    updated_at = Column(DateTime, default=utcnow, onupdate=utcnow, nullable=False)


class ChiefThread(Base):
    """Operational conversation metadata; never canonical personal memory."""

    __tablename__ = "chief_threads"
    __table_args__ = (
        CheckConstraint(
            "length(title) BETWEEN 1 AND 80",
            name="ck_chief_threads_title_length",
        ),
        CheckConstraint(
            "moment_fingerprint IS NULL OR project_fingerprint IS NULL",
            name="ck_chief_threads_single_origin",
        ),
        Index("ix_chief_threads_updated_at", "updated_at"),
        Index(
            "uq_chief_threads_moment_fingerprint",
            "moment_fingerprint",
            unique=True,
        ),
        Index(
            "uq_chief_threads_project_fingerprint",
            "project_fingerprint",
            unique=True,
        ),
    )

    id = Column(String, primary_key=True, default=generate_id)
    title = Column(String, nullable=False)
    moment_fingerprint = Column(String, nullable=True)
    project_fingerprint = Column(String, nullable=True)
    created_at = Column(DateTime, default=utcnow, nullable=False)
    updated_at = Column(DateTime, default=utcnow, onupdate=utcnow, nullable=False)
    version = Column(Integer, default=1, nullable=False)


class ChiefMomentSnapshot(Base):
    """Immutable initiating moment for one conversation thread."""

    __tablename__ = "chief_moment_snapshots"
    __table_args__ = (
        CheckConstraint(
            "length(snapshot_hash) = 64",
            name="ck_chief_moment_snapshots_hash_length",
        ),
        Index(
            "uq_chief_moment_snapshots_thread_id",
            "thread_id",
            unique=True,
        ),
        Index(
            "uq_chief_moment_snapshots_fingerprint",
            "fingerprint",
            unique=True,
        ),
    )

    id = Column(String, primary_key=True, default=generate_id)
    thread_id = Column(
        String,
        ForeignKey("chief_threads.id", ondelete="CASCADE"),
        nullable=False,
    )
    fingerprint = Column(String, nullable=False)
    schema_version = Column(String, nullable=False)
    snapshot_json = Column(Text, nullable=False)
    snapshot_hash = Column(String, nullable=False)
    created_at = Column(DateTime, default=utcnow, nullable=False)


class ChiefProjectSnapshot(Base):
    """Immutable safe activity origin owned only by one conversation."""

    __tablename__ = "chief_project_snapshots"
    __table_args__ = (
        CheckConstraint(
            "length(snapshot_hash) = 64",
            name="ck_chief_project_snapshots_hash_length",
        ),
        Index(
            "uq_chief_project_snapshots_thread_id",
            "thread_id",
            unique=True,
        ),
        Index(
            "uq_chief_project_snapshots_fingerprint",
            "fingerprint",
            unique=True,
        ),
    )

    id = Column(String, primary_key=True, default=generate_id)
    thread_id = Column(
        String,
        ForeignKey("chief_threads.id", ondelete="CASCADE"),
        nullable=False,
    )
    fingerprint = Column(String, nullable=False)
    schema_version = Column(String, nullable=False)
    snapshot_json = Column(Text, nullable=False)
    snapshot_hash = Column(String, nullable=False)
    created_at = Column(DateTime, default=utcnow, nullable=False)


class ChiefMessage(Base):
    """Explicit user text or one fully validated assistant response."""

    __tablename__ = "chief_messages"
    __table_args__ = (
        CheckConstraint(
            "role IN ('user', 'assistant')",
            name="ck_chief_messages_role",
        ),
        CheckConstraint(
            "kind IN ('text', 'response')",
            name="ck_chief_messages_kind",
        ),
        CheckConstraint(
            "length(text) BETWEEN 1 AND 12000",
            name="ck_chief_messages_text_length",
        ),
        Index(
            "ix_chief_messages_thread_created_at",
            "thread_id",
            "created_at",
        ),
        Index(
            "uq_chief_messages_in_reply_to_message_id",
            "in_reply_to_message_id",
            unique=True,
        ),
    )

    id = Column(String, primary_key=True, default=generate_id)
    thread_id = Column(
        String,
        ForeignKey("chief_threads.id", ondelete="CASCADE"),
        nullable=False,
    )
    role = Column(String, nullable=False)
    kind = Column(String, nullable=False)
    text = Column(Text, nullable=False)
    payload_json = Column(Text, nullable=False)
    in_reply_to_message_id = Column(
        String,
        ForeignKey("chief_messages.id", ondelete="CASCADE"),
        nullable=True,
    )
    created_at = Column(DateTime, default=utcnow, nullable=False)


class ChiefTurnRequest(Base):
    """Durable idempotency and commit state for one explicit user turn."""

    __tablename__ = "chief_turn_requests"
    __table_args__ = (
        CheckConstraint(
            "status IN ('pending', 'completed', 'failed', 'timed_out', 'cancelled')",
            name="ck_chief_turn_requests_status",
        ),
        CheckConstraint(
            "length(idempotency_key) = 36",
            name="ck_chief_turn_requests_idempotency_key_length",
        ),
        Index(
            "uq_chief_turn_requests_thread_id_idempotency_key",
            "thread_id",
            "idempotency_key",
            unique=True,
        ),
        Index(
            "ix_chief_turn_requests_thread_status",
            "thread_id",
            "status",
        ),
    )

    id = Column(String, primary_key=True, default=generate_id)
    thread_id = Column(
        String,
        ForeignKey("chief_threads.id", ondelete="CASCADE"),
        nullable=False,
    )
    idempotency_key = Column(String, nullable=False)
    user_message_id = Column(
        String,
        ForeignKey("chief_messages.id", ondelete="CASCADE"),
        nullable=False,
    )
    assistant_message_id = Column(
        String,
        ForeignKey("chief_messages.id", ondelete="CASCADE"),
        nullable=True,
    )
    status = Column(String, default="pending", nullable=False)
    attempt_count = Column(Integer, default=0, nullable=False)
    response_bytes = Column(LargeBinary, nullable=True)
    error_code = Column(String, nullable=True)
    created_at = Column(DateTime, default=utcnow, nullable=False)
    updated_at = Column(DateTime, default=utcnow, onupdate=utcnow, nullable=False)


class ChiefFeedback(Base):
    """One explicit helpful/not-helpful vote for a message or moment."""

    __tablename__ = "chief_feedback"
    __table_args__ = (
        CheckConstraint(
            "((message_id IS NOT NULL AND moment_fingerprint IS NULL) OR "
            "(message_id IS NULL AND moment_fingerprint IS NOT NULL))",
            name="ck_chief_feedback_target",
        ),
        CheckConstraint(
            "value IN ('helpful', 'not_helpful')",
            name="ck_chief_feedback_value",
        ),
        Index("uq_chief_feedback_message_id", "message_id", unique=True),
        Index(
            "uq_chief_feedback_moment_fingerprint",
            "moment_fingerprint",
            unique=True,
        ),
    )

    id = Column(String, primary_key=True, default=generate_id)
    thread_id = Column(
        String,
        ForeignKey("chief_threads.id", ondelete="CASCADE"),
        nullable=True,
    )
    message_id = Column(
        String,
        ForeignKey("chief_messages.id", ondelete="CASCADE"),
        nullable=True,
    )
    moment_fingerprint = Column(String, nullable=True)
    value = Column(String, nullable=False)
    created_at = Column(DateTime, default=utcnow, nullable=False)
    updated_at = Column(DateTime, default=utcnow, onupdate=utcnow, nullable=False)


class DolphinToolRun(Base):
    """Durable reservations prevent replaying a possibly completed mutation."""
    __tablename__ = 'dolphin_tool_runs'
    id = Column(String, primary_key=True)
    turn_id = Column(String, nullable=False, index=True)
    tool = Column(String, nullable=False)
    arguments_json = Column(Text, nullable=False)
    status = Column(String, nullable=False)
    result_json = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, default=utcnow)


class Notification(Base):
    """One thing worth telling the owner about, such as an agent's turn ending.

    ``kind`` leaves room for the planned unified inbox; ``turn_id`` makes
    collection idempotent across rescans and backend restarts.
    """

    __tablename__ = "notifications"

    id = Column(String, primary_key=True, default=generate_id)
    kind = Column(String, nullable=False, default="turn_end", server_default="turn_end")
    turn_id = Column(String, nullable=False, unique=True)
    provider = Column(String, nullable=False)
    project_id = Column(
        String,
        ForeignKey("projects.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    session_name = Column(String, nullable=False)
    pane_id = Column(String, nullable=False)
    summary = Column(Text, nullable=False, default="", server_default="")
    finished_at = Column(DateTime(timezone=True), nullable=False)
    created_at = Column(DateTime(timezone=True), nullable=False, default=utcnow, index=True)
    read_at = Column(DateTime(timezone=True), nullable=True)


# --- Fleet: parent-orchestrated parallel agent work ---------------------------
# Spec: docs/superpowers/specs/2026-09-23-dolphin-fleet-design.md (§11).
# Attempts live in their own table rather than `runs`: runs.task_id is NOT
# NULL and run semantics are welded to research-launch, while a fleet attempt
# may exist with no Dolphin Task at all.


class FleetMission(Base):
    """One user-level objective whose tasks run in parallel."""

    __tablename__ = "fleet_missions"
    __table_args__ = (
        CheckConstraint(
            "state IN ('draft', 'planning', 'running', 'integrating', "
            "'ready_to_ship', 'shipped', 'failed', 'cancelled', 'paused')",
            name="ck_fleet_missions_state",
        ),
        CheckConstraint(
            "autonomy_level BETWEEN 1 AND 4",
            name="ck_fleet_missions_autonomy_level",
        ),
    )

    id = Column(String, primary_key=True, default=generate_id)
    project_id = Column(
        String, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    title = Column(String, nullable=False)
    objective = Column(Text, nullable=False)
    success_criteria = Column(Text, nullable=True)
    autonomy_level = Column(Integer, nullable=False, default=2, server_default="2")
    state = Column(String, nullable=False, default="draft", server_default="draft", index=True)
    repo_path = Column(Text, nullable=False)
    base_ref = Column(String, nullable=True)
    base_sha = Column(String, nullable=True)
    integration_branch = Column(String, nullable=True)
    budget_usd = Column(Integer, nullable=True)
    budget_minutes = Column(Integer, nullable=True)
    started_at = Column(DateTime(timezone=True), nullable=True)
    state_reason = Column(Text, nullable=True)
    # The Lead (phase 3): a visible parent agent that plans, answers and reports.
    lead_enabled = Column(Boolean, nullable=False, default=False, server_default="0")
    lead_restarts = Column(Integer, nullable=False, default=0, server_default="0")
    lead_cursor_seq = Column(Integer, nullable=False, default=0, server_default="0")
    lead_nudged_seq = Column(Integer, nullable=False, default=0, server_default="0")
    plan_ready_at = Column(DateTime(timezone=True), nullable=True)
    plan_notes = Column(Text, nullable=True)
    report = Column(Text, nullable=True)
    shipped_sha = Column(String, nullable=True)
    shipped_to = Column(String, nullable=True)
    created_by = Column(String, nullable=False, default="human", server_default="human")
    # Phase 6: the trigger that started this mission, if one did.
    trigger_id = Column(String, nullable=True, index=True)
    # Phase 7: background from the knowledge brain, fetched once when the first
    # agent starts ("" when there was none or it was unreachable; NULL: not fetched yet).
    brain_context = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), default=utcnow, nullable=False)
    updated_at = Column(DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False)


class FleetTask(Base):
    """A node in a mission's DAG."""

    __tablename__ = "fleet_tasks"
    __table_args__ = (
        CheckConstraint(
            "state IN ('pending', 'ready', 'running', 'verifying', 'reviewing', "
            "'merging', 'landed', 'failed', 'blocked', 'cancelled')",
            name="ck_fleet_tasks_state",
        ),
        CheckConstraint(
            "role IN ('implement', 'research', 'review', 'refinery', 'verify_fix')",
            name="ck_fleet_tasks_role",
        ),
        UniqueConstraint("mission_id", "slug", name="uq_fleet_tasks_mission_slug"),
    )

    id = Column(String, primary_key=True, default=generate_id)
    mission_id = Column(
        String, ForeignKey("fleet_missions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    task_id = Column(String, ForeignKey("tasks.id", ondelete="SET NULL"), nullable=True)
    slug = Column(String, nullable=False)
    title = Column(String, nullable=False)
    role = Column(String, nullable=False, default="implement", server_default="implement")
    spec = Column(Text, nullable=False)
    acceptance_json = Column(Text, nullable=False, default="{}", server_default="{}")
    owned_paths_json = Column(Text, nullable=False, default="[]", server_default="[]")
    agent = Column(String, nullable=False, default="any", server_default="any")
    model = Column(String, nullable=True)
    priority = Column(Integer, nullable=False, default=0, server_default="0")
    # interactive (a visible TUI in tmux) | headless (claude -p, no typing) | container
    lane = Column(String, nullable=False, default="interactive", server_default="interactive")
    state = Column(String, nullable=False, default="pending", server_default="pending", index=True)
    attempt_count = Column(Integer, nullable=False, default=0, server_default="0")
    max_attempts = Column(Integer, nullable=False, default=3, server_default="3")
    # Retryable failures so far (verification, no report, exit, timeout). A
    # cancelled attempt never counts; a worker's own "could not do it" is final.
    failure_count = Column(Integer, nullable=False, default=0, server_default="0")
    failure_kind = Column(String, nullable=True)
    blocked_reason = Column(Text, nullable=True)
    result_summary = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), default=utcnow, nullable=False)
    updated_at = Column(DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False)


class FleetTaskDep(Base):
    __tablename__ = "fleet_task_deps"
    __table_args__ = (
        CheckConstraint("task_id <> depends_on_task_id", name="ck_fleet_task_deps_no_self"),
    )

    task_id = Column(
        String, ForeignKey("fleet_tasks.id", ondelete="CASCADE"), primary_key=True
    )
    depends_on_task_id = Column(
        String, ForeignKey("fleet_tasks.id", ondelete="CASCADE"), primary_key=True, index=True
    )


class FleetAttempt(Base):
    """One run of a fleet task by one agent process in one tmux session."""

    __tablename__ = "fleet_attempts"
    __table_args__ = (
        CheckConstraint(
            "state IN ('spawning', 'started', 'ready', 'working', "
            "'awaiting_permission', 'needs_input', 'turn_ended', 'errored', "
            "'exited', 'start_failed', 'cancelled')",
            name="ck_fleet_attempts_state",
        ),
        CheckConstraint(
            "agent IN ('claude', 'codex', 'fake')", name="ck_fleet_attempts_agent"
        ),
    )

    id = Column(String, primary_key=True, default=generate_id)
    mission_id = Column(
        String, ForeignKey("fleet_missions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # Null for a Lead attempt, which belongs to the mission rather than a task.
    fleet_task_id = Column(
        String, ForeignKey("fleet_tasks.id", ondelete="CASCADE"), nullable=True, index=True
    )
    role = Column(String, nullable=False, default="worker", server_default="worker")
    # task: first or retry attempt in a fresh worktree; refinery: resolves a
    # landing conflict in the previous attempt's worktree.
    purpose = Column(String, nullable=False, default="task", server_default="task")
    agent = Column(String, nullable=False)
    state = Column(String, nullable=False, default="spawning", server_default="spawning", index=True)
    # sha256 of the capability token handed to the session's environment. It
    # binds hook calls to this attempt; it is cross-talk prevention, not auth.
    capability_hash = Column(String, nullable=False)
    session_name = Column(String, nullable=True, index=True)
    workspace_path = Column(Text, nullable=True)
    branch = Column(String, nullable=True)
    base_sha = Column(String, nullable=True)
    provider_session_id = Column(String, nullable=True)
    pane_id = Column(String, nullable=True)
    pane_pid = Column(Integer, nullable=True)
    # The agent process (the pane shell's child that runs the CLI), recorded at
    # launch. Liveness is judged on pid + start ticks, never on silence.
    agent_pid = Column(Integer, nullable=True)
    agent_start_ticks = Column(Integer, nullable=True)
    trust_status = Column(String, nullable=True)
    compact_count = Column(Integer, nullable=False, default=0, server_default="0")
    turn_count = Column(Integer, nullable=False, default=0, server_default="0")
    last_event_at = Column(DateTime(timezone=True), nullable=True)
    ended_at = Column(DateTime(timezone=True), nullable=True)
    error = Column(Text, nullable=True)
    retry_of_attempt_id = Column(String, nullable=True)
    # Done gate (phase 1): the worker's claim, then machine verification, then
    # landing. gate_state: none | reported | reported_failed | verifying |
    # fixing | verified | landing | landed | verify_failed | land_failed | failed
    gate_state = Column(String, nullable=False, default="none", server_default="none")
    gate_blocks = Column(Integer, nullable=False, default=0, server_default="0")
    fix_rounds = Column(Integer, nullable=False, default=0, server_default="0")
    report_outcome = Column(String, nullable=True)
    report_summary = Column(Text, nullable=True)
    report_json = Column(Text, nullable=True)
    reported_at = Column(DateTime(timezone=True), nullable=True)
    verify_log = Column(Text, nullable=True)
    landed_sha = Column(String, nullable=True)
    settled_at = Column(DateTime(timezone=True), nullable=True)
    released_at = Column(DateTime(timezone=True), nullable=True)
    # A human took over this session: Dolphin types nothing into it (messages
    # are held in order and delivered on hand-back) and its time limit pauses.
    human_control = Column(Boolean, nullable=False, default=False, server_default="0")
    held_messages = Column(Text, nullable=False, default="[]", server_default="[]")
    # Usage (phase 5), read from the agent's own transcript.
    transcript_path = Column(Text, nullable=True)
    model = Column(String, nullable=True)
    tokens_in = Column(Integer, nullable=False, default=0, server_default="0")
    tokens_out = Column(Integer, nullable=False, default=0, server_default="0")
    tokens_cache = Column(Integer, nullable=False, default=0, server_default="0")
    cost_usd = Column(Float, nullable=False, default=0.0, server_default="0")
    wrapup_sent_at = Column(DateTime(timezone=True), nullable=True)
    # Permission policy (phase 5): denials for the circuit breaker.
    denials = Column(Integer, nullable=False, default=0, server_default="0")
    consecutive_denials = Column(Integer, nullable=False, default=0, server_default="0")
    # Watchdog (phase 5): screen fingerprint and nudges for stuck detection.
    screen_hash = Column(String, nullable=True)
    screen_changed_at = Column(DateTime(timezone=True), nullable=True)
    stuck_nudges = Column(Integer, nullable=False, default=0, server_default="0")
    last_commit_sha = Column(String, nullable=True)
    turns_since_commit = Column(Integer, nullable=False, default=0, server_default="0")
    # Independent review (phase 5).
    review_verdict = Column(String, nullable=True)
    review_json = Column(Text, nullable=True)
    # What the independent reviewer cost across every round (phase 6).
    review_cost_usd = Column(Float, nullable=False, default=0.0, server_default="0")
    lane = Column(String, nullable=False, default="interactive", server_default="interactive")
    container_name = Column(String, nullable=True)
    created_at = Column(DateTime(timezone=True), default=utcnow, nullable=False)
    updated_at = Column(DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False)


class FleetEvent(Base):
    """Append-only fleet event log: the single source for inbox and UI."""

    __tablename__ = "fleet_events"
    __table_args__ = (UniqueConstraint("event_id", name="uq_fleet_events_event_id"),)

    seq = Column(Integer, primary_key=True, autoincrement=True)
    # Emitter-chosen id: a spooled hook replayed after a lost response is
    # recognised and dropped instead of being applied twice.
    event_id = Column(String, nullable=True)
    mission_id = Column(
        String, ForeignKey("fleet_missions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    attempt_id = Column(
        String, ForeignKey("fleet_attempts.id", ondelete="CASCADE"), nullable=True, index=True
    )
    type = Column(String, nullable=False)
    source = Column(String, nullable=False)
    payload_json = Column(Text, nullable=False, default="{}", server_default="{}")
    emitted_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), default=utcnow, nullable=False)


class FleetWorktree(Base):
    __tablename__ = "fleet_worktrees"
    __table_args__ = (
        CheckConstraint(
            "state IN ('creating', 'setup_pending_approval', 'setting_up', "
            "'active', 'setup_failed', 'removed')",
            name="ck_fleet_worktrees_state",
        ),
        UniqueConstraint("path", name="uq_fleet_worktrees_path"),
    )

    id = Column(String, primary_key=True, default=generate_id)
    mission_id = Column(
        String, ForeignKey("fleet_missions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    attempt_id = Column(String, nullable=True)
    repo_path = Column(Text, nullable=False)
    path = Column(Text, nullable=False)
    branch = Column(String, nullable=False)
    base_sha = Column(String, nullable=False)
    port = Column(Integer, nullable=True)
    state = Column(String, nullable=False, default="creating", server_default="creating")
    setup_hash = Column(String, nullable=True)
    error = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), default=utcnow, nullable=False)
    updated_at = Column(DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False)


class FleetQuestion(Base):
    """A question a worker (or the Lead) needs answered to carry on.

    Routed to the Lead when the mission has one, otherwise to a human. A
    question with a default is answered with it at its deadline, so an
    unanswered question never stalls the fleet; a human-reserved question
    never defaults.
    """

    __tablename__ = "fleet_questions"
    __table_args__ = (
        CheckConstraint("routed_to IN ('lead', 'human')", name="ck_fleet_questions_routed_to"),
        CheckConstraint(
            "state IN ('open', 'answered', 'defaulted', 'cancelled')", name="ck_fleet_questions_state"
        ),
    )

    id = Column(String, primary_key=True, default=generate_id)
    mission_id = Column(
        String, ForeignKey("fleet_missions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    attempt_id = Column(String, ForeignKey("fleet_attempts.id", ondelete="SET NULL"), nullable=True)
    fleet_task_id = Column(String, ForeignKey("fleet_tasks.id", ondelete="SET NULL"), nullable=True)
    asked_by = Column(String, nullable=False)  # worker | lead
    routed_to = Column(String, nullable=False)
    question = Column(Text, nullable=False)
    options_json = Column(Text, nullable=False, default="[]", server_default="[]")
    default_answer = Column(Text, nullable=True)
    why = Column(Text, nullable=True)
    human_reserved = Column(Boolean, nullable=False, default=False, server_default="0")
    state = Column(String, nullable=False, default="open", server_default="open", index=True)
    answer = Column(Text, nullable=True)
    answered_by = Column(String, nullable=True)  # lead | human | default
    deadline_at = Column(DateTime(timezone=True), nullable=True)
    answered_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), default=utcnow, nullable=False)


class FleetControl(Base):
    """Fleet-wide switches, e.g. the global pause (kill switch)."""

    __tablename__ = "fleet_controls"

    key = Column(String, primary_key=True)
    value = Column(Text, nullable=False)
    updated_at = Column(DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False)


class FleetSetupApproval(Base):
    """Operator approval of one exact worktree setup script (by content hash)."""

    __tablename__ = "fleet_setup_approvals"

    repo_path = Column(Text, primary_key=True)
    setup_hash = Column(String, primary_key=True)
    commands_json = Column(Text, nullable=False)
    approved_at = Column(DateTime(timezone=True), default=utcnow, nullable=False)


class FleetTrigger(Base):
    """Continuous work (phase 6): a source Dolphin polls for new missions."""

    __tablename__ = "fleet_triggers"
    __table_args__ = (
        CheckConstraint(
            "kind IN ('schedule', 'github_issues', 'ci_failure', 'todos')",
            name="ck_fleet_triggers_kind",
        ),
        CheckConstraint("autonomy_level BETWEEN 1 AND 4", name="ck_fleet_triggers_autonomy_level"),
    )

    id = Column(String, primary_key=True, default=generate_id)
    project_id = Column(
        String, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name = Column(String, nullable=False)
    kind = Column(String, nullable=False)
    config_json = Column(Text, nullable=False, default="{}", server_default="{}")
    interval_minutes = Column(Integer, nullable=False, default=60, server_default="60")
    autonomy_level = Column(Integer, nullable=False, default=3, server_default="3")
    max_open_missions = Column(Integer, nullable=False, default=1, server_default="1")
    enabled = Column(Boolean, nullable=False, default=True, server_default="1")
    last_checked_at = Column(DateTime(timezone=True), nullable=True)
    next_check_at = Column(DateTime(timezone=True), nullable=True)
    last_result = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), default=utcnow, nullable=False)
    updated_at = Column(DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False)


class FleetTriggerItem(Base):
    """One external item a trigger has already turned into a mission (dedupe)."""

    __tablename__ = "fleet_trigger_items"
    __table_args__ = (
        UniqueConstraint("trigger_id", "external_key", name="uq_fleet_trigger_items_key"),
    )

    id = Column(String, primary_key=True, default=generate_id)
    trigger_id = Column(
        String, ForeignKey("fleet_triggers.id", ondelete="CASCADE"), nullable=False, index=True
    )
    external_key = Column(String, nullable=False)
    mission_id = Column(String, nullable=True)
    created_at = Column(DateTime(timezone=True), default=utcnow, nullable=False)


class FleetLesson(Base):
    """Playbook (phase 7): what a repository taught earlier missions.

    Written by a Lead at the end of a mission or by a person. Active lessons
    go into every brief for that repository; a Lead's lesson starts proposed
    below autonomy 3 and waits for a person to accept it.
    """

    __tablename__ = "fleet_lessons"
    __table_args__ = (
        CheckConstraint("status IN ('proposed', 'active', 'retired')", name="ck_fleet_lessons_status"),
    )

    id = Column(String, primary_key=True, default=generate_id)
    project_id = Column(
        String, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    repo_path = Column(Text, nullable=False, index=True)
    text = Column(Text, nullable=False)
    source = Column(String, nullable=False, default="lead", server_default="lead")
    status = Column(String, nullable=False, default="proposed", server_default="proposed")
    mission_id = Column(String, nullable=True)
    created_at = Column(DateTime(timezone=True), default=utcnow, nullable=False)
    updated_at = Column(DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False)


# --- Project registry and proactive signals ----------------------------------
#
# One place answers "which project is this about?" for chat signals, the agent
# and worklog: a project's chat rooms, people, aliases and its knowledge page.
# Signals are suggestions Dolphin raised on its own; nothing acts until the user
# clicks. See .planning/proactive-chat/ARCHITECTURE.md §3.

PROJECT_LINK_KINDS = ("chat_room", "person", "alias", "brain_page", "repo")


class ProjectLink(Base):
    __tablename__ = "project_links"
    __table_args__ = (
        UniqueConstraint("project_id", "kind", "value", name="uq_project_links_project_kind_value"),
        CheckConstraint(
            "kind IN ('chat_room', 'person', 'alias', 'brain_page', 'repo')",
            name="ck_project_links_kind",
        ),
        CheckConstraint("source IN ('manual', 'learned')", name="ck_project_links_source"),
    )

    id = Column(String, primary_key=True, default=generate_id)
    project_id = Column(String, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True)
    kind = Column(String, nullable=False)
    value = Column(String, nullable=False)
    label = Column(String, nullable=True)
    source = Column(String, nullable=False, default="manual", server_default="manual")
    created_at = Column(DateTime(timezone=True), default=utcnow, nullable=False)


class ChatRoom(Base):
    """How much a chat room may interrupt: work rooms can surface cards,
    community rooms feed only the digest's opportunity lane, system rooms are
    skipped."""

    __tablename__ = "chat_rooms"
    __table_args__ = (
        CheckConstraint("room_class IN ('work', 'community', 'system')", name="ck_chat_rooms_class"),
    )

    chat_id = Column(String, primary_key=True)
    name = Column(String, nullable=False, default="", server_default="")
    room_class = Column(String, nullable=False, default="work", server_default="work")
    updated_at = Column(DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False)


class Signal(Base):
    __tablename__ = "signals"
    __table_args__ = (
        CheckConstraint("lane IN ('project', 'todo', 'opportunity')", name="ck_signals_lane"),
        CheckConstraint(
            "status IN ('pending', 'accepted', 'dismissed', 'stale')", name="ck_signals_status"
        ),
        Index("ix_signals_status_occurred", "status", "occurred_at"),
    )

    id = Column(String, primary_key=True, default=generate_id)
    key = Column(String, nullable=False, unique=True)
    source = Column(String, nullable=False)  # the chat app the signal came from; writers always set it
    lane = Column(String, nullable=False)
    project_id = Column(String, ForeignKey("projects.id", ondelete="SET NULL"), nullable=True, index=True)
    chat_id = Column(String, nullable=False)
    room_name = Column(String, nullable=False, default="", server_default="")
    sender = Column(String, nullable=False, default="", server_default="")
    anchor_msg_id = Column(String, nullable=False)
    msg_ids_json = Column(Text, nullable=False, default="[]", server_default="[]")
    quote = Column(Text, nullable=False)
    title = Column(String, nullable=False)
    why = Column(Text, nullable=False, default="", server_default="")
    plan_json = Column(Text, nullable=False, default="[]", server_default="[]")
    draft_reply = Column(Text, nullable=True)
    confidence = Column(Float, nullable=False, default=0.0, server_default="0")
    status = Column(String, nullable=False, default="pending", server_default="pending")
    replied = Column(Boolean, nullable=False, default=False, server_default="0")
    task_id = Column(String, ForeignKey("tasks.id", ondelete="SET NULL"), nullable=True)
    feedback_reason = Column(String, nullable=True)
    occurred_at = Column(DateTime(timezone=True), nullable=False)
    created_at = Column(DateTime(timezone=True), default=utcnow, nullable=False)
    updated_at = Column(DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False)


class SignalSeenMessage(Base):
    """Every chat message the scanner has already judged, so re-exports of a
    day-file never raise the same suggestion twice."""

    __tablename__ = "signal_seen_messages"

    msg_id = Column(String, primary_key=True)
    day = Column(String, nullable=False, index=True)
    seen_at = Column(DateTime(timezone=True), default=utcnow, nullable=False)
