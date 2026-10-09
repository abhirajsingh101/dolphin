export interface Project {
  id: string;
  name: string;
  emoji: string;
  color: string;
  path: string | null;
  is_inbox: boolean;
  position: number;
  created_at: string;
  updated_at: string;
  task_count: number;
  done_count: number;
  research_instance_id: string | null;
  is_temporary_workspace: boolean;
  serial_queue_id: string | null;
  serial_queue_status: SerialQueueStatus;
  serial_queue_session_name: string | null;
  serial_queue_error: string | null;
  serial_queue_created_at: string | null;
  serial_queue_updated_at: string | null;
}

export type RadarRecommendation = 'try' | 'investigate' | 'watch';
export type RadarFeedbackVote = 'up' | 'down';
export type RadarCategory =
  | 'skill'
  | 'tool'
  | 'update'
  | 'workflow'
  | 'security'
  | 'housekeeping';

export interface RadarEvidence {
  source: string;
  source_class: 'primary' | 'research' | 'code' | 'community';
  title: string;
  url: string;
  published_at: string | null;
  engagement: number;
}

export interface RadarOpportunity {
  id: string;
  title: string;
  summary: string;
  why_it_matters: string;
  recommendation: RadarRecommendation;
  category: RadarCategory;
  score: number;
  confidence: number;
  matched_projects: string[];
  tags: string[];
  is_new: boolean;
  evidence: RadarEvidence[];
}

export interface RadarSourceHealth {
  source: string;
  status: 'healthy' | 'unavailable';
  item_count: number;
  detail: string | null;
  checked_at: string;
}

export interface ImprovementRadarBriefing {
  schema_version: 'dolphin-radar-v1';
  status: 'empty' | 'ready' | 'partial';
  briefing_date: string;
  generated_at: string | null;
  next_scheduled_for: string;
  headline: string;
  project_count: number;
  software_count: number;
  skill_count: number;
  new_count: number;
  inventory: {
    projects: string[];
    software: string[];
    skills: string[];
    topics: string[];
  };
  opportunities: RadarOpportunity[];
  source_health: RadarSourceHealth[];
}

export interface RadarFeedbackReceipt {
  opportunity_id: string;
  vote: RadarFeedbackVote;
  hidden: true;
}

export interface RadarComparisonOption {
  title: string;
  summary: string;
  url: string;
  source: 'github';
  license: string;
  popularity: string;
  created_at: string;
  last_pushed_at: string;
  trend_score: number;
  trend_basis: string;
  comparability_score: number;
  comparison_basis: string;
  evidence: RadarComparisonEvidence[];
}

export interface RadarComparisonEvidence {
  source: 'github' | 'x' | 'reddit';
  title: string;
  url: string;
  engagement: number;
}

export interface RadarComparison {
  schema_version: 'dolphin-radar-comparison-v4';
  search_version: 'agent-reach-comparison-v9';
  opportunity_id: string;
  finding_title: string;
  comparison_target: string;
  generated_at: string;
  status: 'ready' | 'partial' | 'unavailable';
  cached: boolean;
  search_summary: string;
  excluded_count: number;
  decision_criteria: string[];
  options: RadarComparisonOption[];
  source_health: RadarSourceHealth[];
}

export interface Task {
  id: string;
  project_id: string;
  section_id?: string | null;
  title: string;
  description: string;
  origin?: 'human' | 'dolphin';
  execution_prompt?: string;
  priority: number;
  due_date: string | null;
  due_time?: string | null;
  is_done: boolean;
  position: number;
  created_at?: string;
  updated_at?: string;
  completed_at?: string | null;
  project_name?: string;
  project_emoji?: string;
  project_color?: string;
  workflow_state: WorkflowState;
  research_status: ResearchStatus;
  research_session_name: string | null;
  research_error: string | null;
  research_brief: string;
  research_started_at: string | null;
  research_completed_at: string | null;
  placement_kind: PlacementKind | null;
  placement_project_id: string | null;
  placement_project_name: string | null;
  placement_workspace_path: string | null;
  placement_reason: string | null;
  placement_confidence: number | null;
  placement_generated_at: string | null;
  cleanup_status: CleanupStatus;
  cleanup_error: string | null;
  cleanup_archive_path: string | null;
  cleanup_completed_at: string | null;
  serial_queue_id: string | null;
  serial_queue_position: number | null;
  serial_queue_status: SerialQueueItemStatus;
  serial_queue_error: string | null;
  serial_queue_enqueued_at: string | null;
  serial_queue_started_at: string | null;
  serial_queue_completed_at: string | null;
}

export type QualityStage =
  | 'discover'
  | 'specify'
  | 'plan'
  | 'execute'
  | 'verify'
  | 'review'
  | 'done';

export type QualityRisk = 'low' | 'medium' | 'high' | 'critical';

export interface AcceptanceCheck {
  id: string;
  description: string;
}

export interface EvidenceCheck {
  check_id: string;
  passed: boolean;
  evidence: string;
}

export interface QualityContract {
  task_id: string;
  project_id: string;
  desired_outcome: string;
  risk_level: QualityRisk;
  stage: QualityStage;
  acceptance_checks: AcceptanceCheck[];
  required_skills: string[];
  human_review_required: boolean;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface EvidenceReceipt {
  id: string;
  task_id: string;
  project_id: string;
  contract_revision: number;
  producer: string;
  summary: string;
  checks: EvidenceCheck[];
  status: 'submitted' | 'accepted' | 'rejected';
  reviewer: string | null;
  review_reason: string | null;
  submitted_at: string;
  reviewed_at: string | null;
}

export interface OutcomeLesson {
  id: string;
  project_id: string;
  task_id: string;
  receipt_id: string;
  category: 'success' | 'failure' | 'correction' | 'workflow';
  statement: string;
  status: 'proposed' | 'approved' | 'rejected' | 'superseded';
  decided_by: string | null;
  created_at: string;
  decided_at: string | null;
}

export interface SkillCapability {
  name: string;
  description: string;
  source: string;
}

export interface TaskQuality {
  task_id: string;
  project_id: string;
  contract: QualityContract | null;
  receipts: EvidenceReceipt[];
  lessons: OutcomeLesson[];
  available_skills: SkillCapability[];
  missing_required_skills: string[];
}

export interface QualitySummary {
  project_id: string;
  contracts_by_stage: Record<QualityStage, number>;
  contracts_by_risk: Record<QualityRisk, number>;
  evidence: Record<'submitted' | 'accepted' | 'rejected', number>;
  acceptance_rate: number | null;
  awaiting_review: number;
  approved_lessons: number;
  rework_transitions: number;
}

export type WorkflowState = 'todo' | 'in_progress' | 'review' | 'done';

export type ResearchStatus =
  | 'idle'
  | 'launching'
  | 'researching'
  | 'ready'
  | 'failed';

export type PlacementKind =
  | 'explicit_project'
  | 'matched_project'
  | 'temporary';

export type CleanupStatus =
  | 'not_applicable'
  | 'active'
  | 'waiting_for_done'
  | 'waiting_for_session'
  | 'archived'
  | 'failed';

export type SerialQueueStatus =
  | 'idle'
  | 'running'
  | 'paused'
  | 'completed'
  | 'cancelled';

export type SerialQueueItemStatus =
  | 'not_queued'
  | 'queued'
  | 'running'
  | 'completed'
  | 'cancelled'
  | 'failed';

export interface ControlCenterSource {
  state: 'available' | 'degraded' | 'unavailable';
  message: string | null;
}

export interface ControlCenterWorkspace {
  state:
    | 'ready'
    | 'unlinked'
    | 'missing'
    | 'not_directory'
    | 'outside_root'
    | 'unavailable';
  path: string | null;
  message: string;
}

export interface ControlCenterTask {
  id: string;
  project_id: string;
  section_id: string | null;
  title: string;
  description: string;
  origin?: 'human' | 'dolphin';
  execution_prompt?: string;
  priority: number;
  due_date: string | null;
  due_time: string | null;
  is_done: boolean;
  position: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  workflow_state: WorkflowState;
  research_status: ResearchStatus;
  research_session_name: string | null;
  research_error: string | null;
  has_research_brief: boolean;
  research_brief_excerpt: string | null;
  research_started_at: string | null;
  research_completed_at: string | null;
  placement_kind: PlacementKind | null;
  placement_project_id: string | null;
  placement_project_name: string | null;
  placement_workspace_path: string | null;
  placement_reason: string | null;
  placement_confidence: number | null;
  placement_generated_at: string | null;
  cleanup_status: CleanupStatus;
  cleanup_error: string | null;
  cleanup_archive_path: string | null;
  cleanup_completed_at: string | null;
  serial_queue_id: string | null;
  serial_queue_position: number | null;
  serial_queue_status: SerialQueueItemStatus;
  serial_queue_error: string | null;
  serial_queue_enqueued_at: string | null;
  serial_queue_started_at: string | null;
  serial_queue_completed_at: string | null;
  latest_run: LatestRun | null;
}

export interface TaskResearchLaunch {
  task_id: string;
  workflow_state: 'in_progress';
  research_status: 'researching';
  session_name: string;
  reused: boolean;
  project_id: string;
  project_name: string;
  placement_kind: PlacementKind;
  workspace_path: string;
  placement_reason: string;
  placement_confidence: number;
  cleanup_status: CleanupStatus;
}

export interface TaskResearchSessionInputResult {
  task_id: string;
  session_name: string;
  status: 'sent';
}

export interface ControlCenterSession {
  name: string;
  path: string;
  created_at: string;
  windows: number;
  attached: boolean;
  current_command: string | null;
  is_codex_running: boolean;
  has_recent_activity: boolean;
  observation_state: 'available' | 'degraded';
  observation_message: string | null;
}

export interface ControlCenterProject {
  id: string;
  name: string;
  emoji: string;
  color: string;
  path: string | null;
  is_inbox: boolean;
  is_temporary_workspace: boolean;
  position: number;
  created_at: string;
  updated_at: string;
  open_task_count: number;
  session_count: number;
  codex_session_count: number;
  serial_queue_id: string | null;
  serial_queue_status: SerialQueueStatus;
  serial_queue_session_name: string | null;
  serial_queue_error: string | null;
  serial_queue_created_at: string | null;
  serial_queue_updated_at: string | null;
  workspace: ControlCenterWorkspace;
  tasks: ControlCenterTask[];
  sessions: ControlCenterSession[];
}

export interface ControlCenterSnapshot {
  collected_at: string;
  status: 'ok' | 'degraded';
  tmux: ControlCenterSource;
  project_count: number;
  open_task_count: number;
  unique_session_count: number;
  codex_session_count: number;
  needs_setup_count: number;
  projects: ControlCenterProject[];
}

export interface SerialQueueItem {
  task_id: string;
  title: string;
  position: number;
  status: SerialQueueItemStatus;
  error: string | null;
  enqueued_at: string | null;
  started_at: string | null;
  completed_at: string | null;
}

export interface SerialQueue {
  project_id: string;
  queue_id: string | null;
  status: SerialQueueStatus;
  session_name: string | null;
  error: string | null;
  created_at: string | null;
  updated_at: string | null;
  items: SerialQueueItem[];
}

export interface TmuxSession {
  name: string;
  path: string;
  created_at: string;
  windows: number;
  attached: boolean;
  current_command: string | null;
  is_codex_running: boolean;
  is_claude_code_running: boolean;
  has_recent_activity: boolean;
  rename_allowed: boolean;
  rename_block_reason: string | null;
}

export interface WorkspaceStatus {
  project_id: string;
  path: string | null;
  path_exists: boolean;
  is_directory: boolean;
  is_allowed: boolean;
  message: string;
  session_count: number;
  sessions: TmuxSession[];
}

export interface TmuxSnapshot {
  session_name: string;
  content: string;
  captured_at: string;
}

export interface TmuxAttachment {
  attachment_id: string;
  path: string;
  original_name: string;
  kind: 'file' | 'image';
  content_type: string;
  width: number | null;
  height: number | null;
  size_bytes: number;
  created_at: string;
  expires_at: string;
}

export interface WorkspaceDirectory {
  name: string;
  path: string;
  is_project: boolean;
  has_children: boolean;
}

export interface WorkspaceDirectoryList {
  root: string | null;
  directories: WorkspaceDirectory[];
}

export interface HarnessLayer {
  id: string;
  label: string;
  description: string;
}

export interface HarnessSource {
  id: string;
  path: string;
  label: string;
  kind: string;
  size_bytes: number;
}

export interface HarnessNode {
  id: string;
  label: string;
  layer: string;
  kind: string;
  role: string;
  source_path: string;
  source_label: string;
  confidence: 'explicit' | 'inferred' | string;
  description: string | null;
  metadata: Record<string, unknown>;
}


export interface HarnessEdge {
  id: string;
  source: string;
  target: string;
  label: string;
  kind: string;
  confidence: 'explicit' | 'inferred' | string;
  source_path: string | null;
}

export interface HarnessMapSummary {
  source_count: number;
  node_count: number;
  edge_count: number;
  explicit_node_count: number;
  inferred_node_count: number;
}

export interface HarnessMap {
  project_id: string;
  path: string;
  generated_at: string;
  layers: HarnessLayer[];
  sources: HarnessSource[];
  nodes: HarnessNode[];
  edges: HarnessEdge[];
  summary: HarnessMapSummary;
}

export interface ResearchInstance {
  instance_id: string;
  topic: string;
  status: string;
  created_at: string;
  communications_ready: boolean;
  linked_project_id: string | null;
  linked_project_name: string | null;
}

export interface ResearchBinding {
  project_id: string;
  instance_id: string;
  topic: string;
  status: string;
  communications_ready: boolean;
  created_at: string;
  updated_at: string;
}





















export type SystemHealthStatus =
  | 'healthy'
  | 'warning'
  | 'critical'
  | 'unavailable';

export interface SystemHealthFilesystem {
  mount: string;
  available_bytes: number;
  used_bytes: number;
  reserved_bytes: number;
  total_bytes: number;
  usage_percent: number;
}

export interface SystemHealthDisk {
  name: string;
  read_bytes_per_second: number;
  write_bytes_per_second: number;
}

export interface SystemHealthInterface {
  name: string;
  received_bytes_per_second: number;
  sent_bytes_per_second: number;
}

export interface SystemHealthGpu {
  index: number;
  name: string;
  uuid: string;
  usage_percent: number | null;
  memory_used_bytes: number | null;
  memory_total_bytes: number | null;
  memory_usage_percent: number | null;
  temperature_celsius: number | null;
  power_watts: number | null;
  power_limit_watts: number | null;
}

export interface SystemHealthSummary {
  available: boolean;
  status: SystemHealthStatus;
  source: string;
  message: string | null;
  collected_at: string;
  netdata_version: string | null;
  host: {
    hostname: string;
    os: string;
    kernel: string;
    architecture: string;
    cpu_model: string;
    cpu_cores: number;
    uptime_seconds: number;
  };
  cpu: {
    usage_percent: number;
    load1: number;
    load5: number;
    load15: number;
  };
  memory: {
    total_bytes: number;
    used_bytes: number;
    cached_bytes: number;
    free_bytes: number;
    usage_percent: number;
  };
  swap: {
    total_bytes: number;
    used_bytes: number;
    free_bytes: number;
    usage_percent: number;
  };
  disk_io: {
    read_bytes_per_second: number;
    write_bytes_per_second: number;
  };
  network: {
    received_bytes_per_second: number;
    sent_bytes_per_second: number;
  };
  filesystems: SystemHealthFilesystem[];
  disks: SystemHealthDisk[];
  interfaces: SystemHealthInterface[];
  gpus: SystemHealthGpu[];
  temperatures: Array<{
    label: string;
    source: string;
    celsius: number;
  }>;
  alerts: {
    normal: number;
    warning: number;
    critical: number;
  };
  smart: {
    available: boolean;
    metric_contexts: number;
  };
}

export interface SystemHealthHistoryPoint {
  timestamp: number;
  value: number;
}

export interface SystemHealthHistorySeries {
  name: string;
  points: SystemHealthHistoryPoint[];
}

export interface SystemHealthHistory {
  available: boolean;
  metric: string;
  unit: string;
  seconds: number;
  series: SystemHealthHistorySeries[];
  collected_at: string;
  message: string | null;
}

export interface SystemHealthAlert {
  id: string;
  name: string;
  status: 'warning' | 'critical';
  chart: string | null;
  value: number | null;
  units: string;
  summary: string;
  detail: string;
  updated_at: number;
}

export interface SystemHealthAlerts {
  available: boolean;
  counts: {
    warning: number;
    critical: number;
  };
  alerts: SystemHealthAlert[];
  collected_at: string;
  message: string | null;
}

export interface SystemHealthProcess {
  pid: number;
  name: string;
  cpu_percent: number;
  memory_bytes: number;
}

export interface SystemHealthWorkload {
  name: string;
  kind: string | null;
  pids: number;
  cpu_percent: number;
  memory_bytes: number;
  read_bytes: number;
  write_bytes: number;
  received_bytes_per_second: number;
  sent_bytes_per_second: number;
}

export interface SystemHealthSmartDevice {
  name: string;
  type: string;
  protocol: string;
  status: string;
  message: string | null;
}

export interface SystemHealthWorkloads {
  available: boolean;
  processes: SystemHealthProcess[];
  containers: SystemHealthWorkload[];
  services: SystemHealthWorkload[];
  smart: {
    available: boolean;
    devices: SystemHealthSmartDevice[];
    message: string | null;
  };
  collected_at: string;
  message: string | null;
}

export type RunState =
  | 'dispatched'
  | 'running'
  | 'awaiting_receipt'
  | 'needs_review'
  | 'approved'
  | 'dismissed'
  | 'failed'
  | 'abandoned';

export interface LatestRun {
  id: string;
  state: RunState;
  agent: string;
  turn_count: number;
  dispatched_at: string;
  has_receipt: boolean;
}

export interface WorkspaceRoot {
  path: string;
  name: string;
  exists: boolean;
}

/* One path-shaped token from a terminal snapshot, as the server classified it.
   Only 'file' is downloadable; everything else renders as plain text. */
export interface TerminalPathResolution {
  candidate: string;
  path: string | null;
  kind: 'file' | 'directory' | 'symlink' | 'special' | 'missing' | 'denied';
  size_bytes: number | null;
}

export interface AppNotification {
  id: string;
  kind: 'turn_end';
  turn_id: string;
  provider: 'claude' | 'codex';
  project_id: string | null;
  project_name: string | null;
  session_name: string;
  pane_id: string;
  summary: string;
  finished_at: string;
  created_at: string;
  read: boolean;
}

export interface NotificationList {
  items: AppNotification[];
  unread_count: number;
}
