from datetime import date, datetime, time
from enum import Enum
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field, field_validator


# --- Projects ---

class ProjectCreate(BaseModel):
    name: str
    emoji: str = ""
    color: str = "#6B7280"
    path: Optional[str] = None
    is_inbox: bool = False
    position: int = 0


class ProjectUpdate(BaseModel):
    name: Optional[str] = None
    emoji: Optional[str] = None
    color: Optional[str] = None
    path: Optional[str] = None
    position: Optional[int] = None


class ProjectResponse(BaseModel):
    id: str
    name: str
    emoji: str
    color: str
    path: Optional[str] = None
    is_inbox: bool
    position: int
    created_at: datetime
    updated_at: datetime
    task_count: int = 0
    done_count: int = 0
    research_instance_id: Optional[str] = None
    is_temporary_workspace: bool = False
    serial_queue_id: Optional[str] = None
    serial_queue_status: Literal[
        "idle", "running", "paused", "completed", "cancelled"
    ] = "idle"
    serial_queue_session_name: Optional[str] = None
    serial_queue_error: Optional[str] = None
    serial_queue_created_at: Optional[datetime] = None
    serial_queue_updated_at: Optional[datetime] = None

    model_config = {"from_attributes": True}


# --- Sections ---

class SectionCreate(BaseModel):
    project_id: str
    name: str
    position: int = 0


class SectionUpdate(BaseModel):
    name: Optional[str] = None
    position: Optional[int] = None
    is_collapsed: Optional[bool] = None


class SectionResponse(BaseModel):
    id: str
    project_id: str
    name: str
    position: int
    is_collapsed: bool
    created_at: datetime

    model_config = {"from_attributes": True}


# --- Labels ---

class LabelCreate(BaseModel):
    name: str
    color: str = "#6B7280"
    position: int = 0


class LabelUpdate(BaseModel):
    name: Optional[str] = None
    color: Optional[str] = None
    position: Optional[int] = None


class LabelResponse(BaseModel):
    id: str
    name: str
    color: str
    position: int

    model_config = {"from_attributes": True}


# --- Tasks ---

class TaskCreate(BaseModel):
    project_id: Optional[str] = None
    section_id: Optional[str] = None
    title: str
    description: str = ""
    execution_prompt: str = Field(default="", max_length=8_000)
    priority: int = Field(default=4, ge=1, le=4)
    due_date: Optional[date] = None
    due_time: Optional[time] = None
    label_ids: list[str] = []

    @field_validator("title")
    @classmethod
    def _valid_task_title(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized or any(character in normalized for character in "\x00\r\n"):
            raise ValueError("task title must contain visible text")
        return normalized

    @field_validator("execution_prompt")
    @classmethod
    def _valid_execution_prompt(cls, value: str) -> str:
        normalized = value.strip()
        if "</dolphin-execution-instruction>" in normalized.casefold():
            raise ValueError("execution prompt contains a reserved control delimiter")
        return normalized


class TaskUpdate(BaseModel):
    project_id: Optional[str] = None
    section_id: Optional[str] = None
    title: Optional[str] = None
    description: Optional[str] = None
    execution_prompt: Optional[str] = Field(default=None, max_length=8_000)
    priority: Optional[int] = Field(default=None, ge=1, le=4)
    due_date: Optional[date] = None
    due_time: Optional[time] = None
    is_done: Optional[bool] = None
    workflow_state: Optional[
        Literal["todo", "in_progress", "review", "done"]
    ] = None
    position: Optional[int] = None
    label_ids: Optional[list[str]] = None

    @field_validator("title")
    @classmethod
    def _valid_updated_title(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        normalized = value.strip()
        if not normalized or any(character in normalized for character in "\x00\r\n"):
            raise ValueError("task title must contain visible text")
        return normalized

    @field_validator("execution_prompt")
    @classmethod
    def _valid_updated_execution_prompt(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        normalized = value.strip()
        if not normalized:
            raise ValueError("execution prompt must contain visible text")
        if "</dolphin-execution-instruction>" in normalized.casefold():
            raise ValueError("execution prompt contains a reserved control delimiter")
        return normalized


class CompletedTaskDeleteRequest(BaseModel):
    task_ids: list[str] = Field(min_length=1)


class CompletedTaskDeleteResponse(BaseModel):
    deleted_task_ids: list[str]
    skipped_task_ids: list[str]


class TaskResponse(BaseModel):
    id: str
    project_id: str
    section_id: Optional[str] = None
    title: str
    description: str
    origin: Literal["human", "dolphin"] = "human"
    execution_prompt: str = ""
    priority: int
    due_date: Optional[date] = None
    due_time: Optional[time] = None
    is_done: bool
    position: int
    created_at: datetime
    updated_at: datetime
    completed_at: Optional[datetime] = None
    labels: list[LabelResponse] = []
    project_name: Optional[str] = None
    project_emoji: Optional[str] = None
    project_color: Optional[str] = None
    workflow_state: Literal["todo", "in_progress", "review", "done"] = "todo"
    research_status: Literal[
        "idle", "launching", "researching", "ready", "failed"
    ] = "idle"
    research_session_name: Optional[str] = None
    research_error: Optional[str] = None
    research_brief: str = ""
    research_started_at: Optional[datetime] = None
    research_completed_at: Optional[datetime] = None
    placement_kind: Optional[
        Literal["explicit_project", "matched_project", "temporary"]
    ] = None
    placement_project_id: Optional[str] = None
    placement_project_name: Optional[str] = None
    placement_workspace_path: Optional[str] = None
    placement_reason: Optional[str] = None
    placement_confidence: Optional[int] = None
    placement_generated_at: Optional[datetime] = None
    cleanup_status: Literal[
        "not_applicable",
        "active",
        "waiting_for_done",
        "waiting_for_session",
        "archived",
        "failed",
    ] = "not_applicable"
    cleanup_error: Optional[str] = None
    cleanup_archive_path: Optional[str] = None
    cleanup_completed_at: Optional[datetime] = None
    serial_queue_id: Optional[str] = None
    serial_queue_position: Optional[int] = None
    serial_queue_status: Literal[
        "not_queued",
        "queued",
        "running",
        "completed",
        "cancelled",
        "failed",
    ] = "not_queued"
    serial_queue_error: Optional[str] = None
    serial_queue_enqueued_at: Optional[datetime] = None
    serial_queue_started_at: Optional[datetime] = None
    serial_queue_completed_at: Optional[datetime] = None

    model_config = {"from_attributes": True}


class TaskResearchLaunchResponse(BaseModel):
    task_id: str
    workflow_state: Literal["in_progress"]
    research_status: Literal["researching", "ready"]
    session_name: str
    reused: bool
    project_id: str
    project_name: str
    placement_kind: Literal[
        "explicit_project", "matched_project", "temporary"
    ]
    workspace_path: str
    placement_reason: str
    placement_confidence: int
    cleanup_status: Literal[
        "not_applicable",
        "active",
        "waiting_for_done",
        "waiting_for_session",
        "archived",
        "failed",
    ]


class TaskResearchSessionInput(BaseModel):
    text: str = Field(min_length=1, max_length=20_000)


class TaskResearchSessionInputResponse(BaseModel):
    task_id: str
    session_name: str
    status: Literal["sent"]


class ResearchBriefUpdate(BaseModel):
    research_brief: str = Field(min_length=1, max_length=200_000)


class ResearchBriefResponse(BaseModel):
    task_id: str
    research_status: Literal["ready"]
    research_brief: str
    research_completed_at: datetime


# --- Reorder ---

class ReorderRequest(BaseModel):
    task_ids: list[str]


# --- Stats ---

class StatsResponse(BaseModel):
    total_tasks: int
    completed_tasks: int
    pending_tasks: int
    overdue_tasks: int
    tasks_due_today: int
    projects_count: int
    labels_count: int


# --- Control center ---

class ControlCenterSourceResponse(BaseModel):
    state: Literal["available", "degraded", "unavailable"]
    message: Optional[str] = None


class ControlCenterWorkspaceResponse(BaseModel):
    state: Literal[
        "ready",
        "unlinked",
        "missing",
        "not_directory",
        "outside_root",
        "unavailable",
    ]
    path: Optional[str] = None
    message: str


class ControlCenterLatestRunResponse(BaseModel):
    id: str
    state: str
    agent: str
    turn_count: int
    dispatched_at: datetime
    has_receipt: bool


class ControlCenterTaskResponse(BaseModel):
    id: str
    project_id: str
    section_id: Optional[str] = None
    title: str
    description: str
    origin: Literal["human", "dolphin"] = "human"
    execution_prompt: str = ""
    priority: int
    due_date: Optional[date] = None
    due_time: Optional[time] = None
    is_done: bool
    position: int
    created_at: datetime
    updated_at: datetime
    completed_at: Optional[datetime] = None
    workflow_state: Literal["todo", "in_progress", "review", "done"] = "todo"
    research_status: Literal[
        "idle", "launching", "researching", "ready", "failed"
    ] = "idle"
    research_session_name: Optional[str] = None
    research_error: Optional[str] = None
    has_research_brief: bool = False
    research_brief_excerpt: Optional[str] = None
    research_started_at: Optional[datetime] = None
    research_completed_at: Optional[datetime] = None
    placement_kind: Optional[
        Literal["explicit_project", "matched_project", "temporary"]
    ] = None
    placement_project_id: Optional[str] = None
    placement_project_name: Optional[str] = None
    placement_workspace_path: Optional[str] = None
    placement_reason: Optional[str] = None
    placement_confidence: Optional[int] = None
    placement_generated_at: Optional[datetime] = None
    cleanup_status: Literal[
        "not_applicable",
        "active",
        "waiting_for_done",
        "waiting_for_session",
        "archived",
        "failed",
    ] = "not_applicable"
    cleanup_error: Optional[str] = None
    cleanup_archive_path: Optional[str] = None
    cleanup_completed_at: Optional[datetime] = None
    serial_queue_id: Optional[str] = None
    serial_queue_position: Optional[int] = None
    serial_queue_status: Literal[
        "not_queued",
        "queued",
        "running",
        "completed",
        "cancelled",
        "failed",
    ] = "not_queued"
    serial_queue_error: Optional[str] = None
    serial_queue_enqueued_at: Optional[datetime] = None
    serial_queue_started_at: Optional[datetime] = None
    serial_queue_completed_at: Optional[datetime] = None
    # The LATEST run, not the active one. A field carrying only non-terminal
    # runs would go null on approval and the card would fall back to
    # research_status -- rendering "Researching" again for work that is
    # finished and approved. Once a task has had a run, that run owns the
    # card's agent chip (spec §4.5).
    latest_run: Optional[ControlCenterLatestRunResponse] = None


class ControlCenterSessionResponse(BaseModel):
    name: str
    path: str
    created_at: datetime
    windows: int
    attached: bool
    current_command: Optional[str] = None
    is_codex_running: bool
    has_recent_activity: bool
    last_activity_at: Optional[datetime] = None
    observation_state: Literal["available", "degraded"] = "available"
    observation_message: Optional[str] = None


class ControlCenterProjectResponse(BaseModel):
    id: str
    name: str
    emoji: str
    color: str
    path: Optional[str] = None
    is_inbox: bool
    is_temporary_workspace: bool = False
    position: int
    created_at: datetime
    updated_at: datetime
    open_task_count: int
    session_count: int
    codex_session_count: int
    serial_queue_id: Optional[str] = None
    serial_queue_status: Literal[
        "idle", "running", "paused", "completed", "cancelled"
    ] = "idle"
    serial_queue_session_name: Optional[str] = None
    serial_queue_error: Optional[str] = None
    serial_queue_created_at: Optional[datetime] = None
    serial_queue_updated_at: Optional[datetime] = None
    workspace: ControlCenterWorkspaceResponse
    tasks: list[ControlCenterTaskResponse] = Field(default_factory=list)
    sessions: list[ControlCenterSessionResponse] = Field(default_factory=list)


class ControlCenterResponse(BaseModel):
    collected_at: datetime
    status: Literal["ok", "degraded"]
    tmux: ControlCenterSourceResponse
    project_count: int
    open_task_count: int
    unique_session_count: int
    codex_session_count: int
    needs_setup_count: int
    projects: list[ControlCenterProjectResponse] = Field(default_factory=list)


# --- System health ---

class SystemHealthSummaryResponse(BaseModel):
    available: bool
    status: Literal["healthy", "warning", "critical", "unavailable"]
    source: str
    message: Optional[str] = None
    collected_at: datetime
    netdata_version: Optional[str] = None
    host: dict[str, Any]
    cpu: dict[str, Any]
    memory: dict[str, Any]
    swap: dict[str, Any]
    disk_io: dict[str, Any]
    network: dict[str, Any]
    filesystems: list[dict[str, Any]] = []
    disks: list[dict[str, Any]] = []
    interfaces: list[dict[str, Any]] = []
    gpus: list[dict[str, Any]] = []
    temperatures: list[dict[str, Any]] = []
    alerts: dict[str, int]
    smart: dict[str, Any]


class SystemHealthHistoryResponse(BaseModel):
    available: bool
    metric: str
    unit: str
    seconds: int
    series: list[dict[str, Any]] = []
    collected_at: datetime
    message: Optional[str] = None


class SystemHealthAlertsResponse(BaseModel):
    available: bool
    counts: dict[str, int]
    alerts: list[dict[str, Any]] = []
    collected_at: datetime
    message: Optional[str] = None


class SystemHealthWorkloadsResponse(BaseModel):
    available: bool
    processes: list[dict[str, Any]] = []
    containers: list[dict[str, Any]] = []
    services: list[dict[str, Any]] = []
    smart: dict[str, Any]
    collected_at: datetime
    message: Optional[str] = None


# --- Workspace / tmux ---

class TmuxSessionResponse(BaseModel):
    name: str
    path: str
    created_at: datetime
    windows: int
    attached: bool
    current_command: Optional[str] = None
    is_codex_running: bool = False
    is_claude_code_running: bool = False
    has_recent_activity: bool = False
    rename_allowed: bool = True
    rename_block_reason: Optional[str] = None


class WorkspaceResponse(BaseModel):
    project_id: str
    path: Optional[str] = None
    path_exists: bool
    is_directory: bool
    is_allowed: bool
    message: str
    session_count: int
    sessions: list[TmuxSessionResponse] = []


class TmuxSessionCreate(BaseModel):
    name: Optional[str] = None
    mode: str = "shell"


class TmuxSessionRename(BaseModel):
    name: str = Field(min_length=1, max_length=80)


class TmuxInputRequest(BaseModel):
    text: str = ""
    enter: bool = True


class TmuxKeyRequest(BaseModel):
    key: str


class TmuxSnapshotResponse(BaseModel):
    session_name: str
    content: str
    captured_at: datetime


class TmuxAttachmentResponse(BaseModel):
    attachment_id: str
    path: str
    original_name: str
    kind: Literal["file", "image"]
    content_type: str
    width: Optional[int] = None
    height: Optional[int] = None
    size_bytes: int
    created_at: datetime
    expires_at: datetime


class CodexTodoDispatchRequest(BaseModel):
    session_name: Optional[str] = None
    task_id: Optional[str] = None
    mode: Literal["start", "queue"] = "start"


class CodexTodoDispatchResponse(BaseModel):
    session_name: str
    task_count: int
    message: str


class SerialQueueStartRequest(BaseModel):
    task_ids: list[str] = Field(min_length=1, max_length=50)


class SerialQueueItemResponse(BaseModel):
    task_id: str
    title: str
    position: int
    status: Literal[
        "not_queued",
        "queued",
        "running",
        "completed",
        "cancelled",
        "failed",
    ]
    error: Optional[str] = None
    enqueued_at: Optional[datetime] = None
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None

    model_config = {"from_attributes": True}


class SerialQueueResponse(BaseModel):
    project_id: str
    queue_id: Optional[str] = None
    status: Literal["idle", "running", "paused", "completed", "cancelled"]
    session_name: Optional[str] = None
    error: Optional[str] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    items: list[SerialQueueItemResponse] = Field(default_factory=list)

    model_config = {"from_attributes": True}


class WorkspaceRootResponse(BaseModel):
    path: str
    name: str
    exists: bool


class WorkspaceDirectoryResponse(BaseModel):
    name: str
    path: str
    is_project: bool = False
    has_children: bool = False


class WorkspaceDirectoryListResponse(BaseModel):
    # None when the result set spans more than one root, which a search with
    # no explicit `root` does. Naming one root there would be a lie about
    # where the results came from.
    root: Optional[str] = None
    directories: list[WorkspaceDirectoryResponse] = []


class TerminalPathResolveRequest(BaseModel):
    session_name: Optional[str] = None
    candidates: list[str] = Field(default_factory=list)


class ResolvedTerminalPathResponse(BaseModel):
    candidate: str
    path: Optional[str] = None
    kind: Literal[
        "file",
        "directory",
        "symlink",
        "special",
        "missing",
        "denied",
    ]
    size_bytes: Optional[int] = None


class TerminalPathResolveResponse(BaseModel):
    paths: list[ResolvedTerminalPathResponse] = Field(default_factory=list)


class WorkspaceDirectoryCreateRequest(BaseModel):
    parent: str
    name: str


# --- Harness control map ---

class HarnessLayerResponse(BaseModel):
    id: str
    label: str
    description: str


class HarnessSourceResponse(BaseModel):
    id: str
    path: str
    label: str
    kind: str
    size_bytes: int


class HarnessNodeResponse(BaseModel):
    id: str
    label: str
    layer: str
    kind: str
    role: str
    source_path: str
    source_label: str
    confidence: str = "explicit"
    description: Optional[str] = None
    metadata: dict[str, Any] = {}


class HarnessEdgeResponse(BaseModel):
    id: str
    source: str
    target: str
    label: str
    kind: str
    confidence: str = "explicit"
    source_path: Optional[str] = None


class HarnessMapSummaryResponse(BaseModel):
    source_count: int
    node_count: int
    edge_count: int
    explicit_node_count: int
    inferred_node_count: int


class HarnessMapResponse(BaseModel):
    project_id: str
    path: str
    generated_at: datetime
    layers: list[HarnessLayerResponse]
    sources: list[HarnessSourceResponse]
    nodes: list[HarnessNodeResponse]
    edges: list[HarnessEdgeResponse]
    summary: HarnessMapSummaryResponse


# --- Research OS professor workspace ---

class ResearchInstanceResponse(BaseModel):
    instance_id: str
    topic: str
    status: str
    created_at: datetime
    communications_ready: bool
    linked_project_id: Optional[str] = None
    linked_project_name: Optional[str] = None


class ResearchBindingUpdate(BaseModel):
    instance_id: str = Field(min_length=1, max_length=200)


class ResearchBindingResponse(BaseModel):
    project_id: str
    instance_id: str
    topic: str
    status: str
    communications_ready: bool
    created_at: datetime
    updated_at: datetime


class ResearchSnapshotResponse(BaseModel):
    project_id: str
    contract: str
    generated_at: datetime
    instance: dict[str, Any]
    profile: Optional[dict[str, Any]] = None
    counts: dict[str, int]
    latest_activity_at: datetime
    professor_briefing: Optional[dict[str, Any]] = None
    communication_completeness: Optional[dict[str, Any]] = None
    latest_report: Optional[dict[str, Any]] = None
    notebook_entries: list[dict[str, Any]] = []
    findings: list[dict[str, Any]] = []
    figures: list[dict[str, Any]] = []
    documents: list[dict[str, Any]] = []
    reports: list[dict[str, Any]] = []
    exports: list[dict[str, Any]] = []
    latest_advisor_export: Optional[dict[str, Any]] = None


class ResearchReportCreate(BaseModel):
    title: Optional[str] = Field(default=None, max_length=300)


class ResearchWorkspaceExportCreate(BaseModel):
    audience: Literal["advisor", "public"] = "advisor"


class ResearchMutationResponse(BaseModel):
    result: dict[str, Any]


# --- Runs (Phase B run lifecycle) ---

class RunStateFilter(str, Enum):
    """The `state` query filter for GET /api/runs.

    Deliberately an enum rather than `list[str]`: an unfiltered `list[str]`
    made `?state=bogus` return `[]`, which under a review queue renders as
    "no work waiting" -- the one lie a review queue must never tell.
    `test_every_real_run_state_is_accepted` guards it against drifting from
    `run_service.RUN_STATES`.
    """

    dispatched = "dispatched"
    running = "running"
    awaiting_receipt = "awaiting_receipt"
    needs_review = "needs_review"
    approved = "approved"
    dismissed = "dismissed"
    failed = "failed"
    abandoned = "abandoned"


class RunEventRequest(BaseModel):
    type: Literal["turn_end", "failed"]
    message: str | None = None


class RunEventResponse(BaseModel):
    block: bool
    reason: str = ""


class RunResponse(BaseModel):
    id: str
    task_id: str
    project_id: str
    session_name: str
    agent: str
    state: str
    dispatched_at: datetime
    started_at: datetime | None
    ended_at: datetime | None
    turn_count: int
    receipt_path: str | None
    error: str | None


class RunListItemResponse(BaseModel):
    """What GET /api/runs returns. `RunResponse` stays the bare shape that
    approve/dismiss/retry return -- those answer with one run they just
    mutated, and the surface refetches the list afterwards anyway."""

    id: str
    task_id: str
    project_id: str
    session_name: str
    agent: str
    state: str
    dispatched_at: datetime
    started_at: datetime | None
    ended_at: datetime | None
    last_event_at: datetime | None
    turn_count: int
    receipt_path: str | None
    has_receipt: bool
    error: str | None
    task_title: str
    project_name: str


class RunReceiptResponse(BaseModel):
    path: str
    text: str
    truncated: bool


class OwnerTaskCompletion(BaseModel):
    is_done: bool
