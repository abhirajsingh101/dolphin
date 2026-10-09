import type {
  NotificationList,
  ControlCenterSnapshot,
  HarnessMap,
  ImprovementRadarBriefing,
  RadarComparison,
  RadarFeedbackReceipt,
  RadarFeedbackVote,
  Project,
  ResearchBinding,
  ResearchInstance,
  SerialQueue,
  SystemHealthAlerts,
  SystemHealthHistory,
  SystemHealthSummary,
  SystemHealthWorkloads,
  Task,
  TaskQuality,
  QualityContract,
  QualityStage,
  QualityRisk,
  AcceptanceCheck,
  EvidenceCheck,
  QualitySummary,
  TaskResearchLaunch,
  TaskResearchSessionInputResult,
  TerminalPathResolution,
  TmuxAttachment,
  TmuxSnapshot,
  TmuxSession,
  WorkspaceDirectory,
  WorkspaceDirectoryList,
  WorkspaceRoot,
  WorkspaceStatus,
} from './types';

const browserLocation =
  typeof window === 'undefined'
    ? { protocol: 'http:', hostname: '127.0.0.1' }
    : window.location;

/* Dolphin Desktop's preload hands each window the helper it talks to: a local
   port, or the local end of an SSH forward, plus the helper's token. The web
   app has no such object and keeps the same-host :8400 default. */
type DesktopConfig = { apiBase: string; token?: string };
const desktopConfig: DesktopConfig | undefined =
  typeof window === 'undefined'
    ? undefined
    : (window as { dolphinDesktop?: { config?: DesktopConfig } }).dolphinDesktop?.config;

export const API_BASE =
  desktopConfig?.apiBase ??
  import.meta.env.VITE_API_URL ??
  `${browserLocation.protocol}//${browserLocation.hostname}:8400`;

export const API_TOKEN = desktopConfig?.token ?? '';

/** The helper's token as a header, for requests that can carry one. */
export function authHeaders(): Record<string, string> {
  return API_TOKEN ? { 'X-Dolphin-Token': API_TOKEN } : {};
}

/** The token as a query parameter, for URLs the browser opens itself
    (EventSource, WebSocket, download links), which cannot send headers. */
export function withToken(url: string): string {
  if (!API_TOKEN) return url;
  return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(API_TOKEN)}`;
}

export const WS_BASE = API_BASE.replace(/^http/, 'ws');

export class DolphinApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = 'DolphinApiError';
  }
}

function responseError(
  payload: unknown,
  status: number,
  fallback: string,
): DolphinApiError {
  if (
    typeof payload === 'object' &&
    payload !== null &&
    !Array.isArray(payload) &&
    'detail' in payload
  ) {
    const detail = payload.detail;
    if (typeof detail === 'string' && detail.trim()) {
      return new DolphinApiError(detail, status, detail);
    }
    if (
      typeof detail === 'object' &&
      detail !== null &&
      !Array.isArray(detail) &&
      Object.keys(detail).every((key) => key === 'code' || key === 'message') &&
      'code' in detail &&
      'message' in detail &&
      typeof detail.code === 'string' &&
      /^[a-z][a-z0-9_]{0,63}$/.test(detail.code) &&
      typeof detail.message === 'string' &&
      detail.message.trim().length > 0 &&
      detail.message.length <= 240
    ) {
      return new DolphinApiError(detail.message, status, detail.code);
    }
  }
  return new DolphinApiError(fallback, status);
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    const fallback = `${response.status} ${response.statusText}`;
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new DolphinApiError(fallback, response.status);
    }
    throw responseError(payload, response.status, fallback);
  }

  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

export function fetchProjects(): Promise<Project[]> {
  return request<Project[]>('/api/projects');
}

export function fetchControlCenter(
  signal?: AbortSignal,
): Promise<ControlCenterSnapshot> {
  return request<ControlCenterSnapshot>('/api/control-center', { signal });
}

export function fetchControlCenterDeck(
  signal?: AbortSignal,
): Promise<ControlCenterSnapshot> {
  return request<ControlCenterSnapshot>('/api/control-center/deck', { signal });
}

export function fetchImprovementRadarBriefing(
  signal?: AbortSignal,
): Promise<ImprovementRadarBriefing> {
  return request<ImprovementRadarBriefing>('/api/improvement-radar/briefing', {
    signal,
  });
}

export function submitImprovementRadarFeedback(
  opportunityId: string,
  vote: RadarFeedbackVote,
): Promise<RadarFeedbackReceipt> {
  return request<RadarFeedbackReceipt>(
    `/api/improvement-radar/opportunities/${encodeURIComponent(opportunityId)}/feedback`,
    {
      method: 'POST',
      body: JSON.stringify({ vote }),
    },
  );
}

export function compareImprovementRadarOpportunity(
  opportunityId: string,
): Promise<RadarComparison> {
  return request<RadarComparison>(
    `/api/improvement-radar/opportunities/${encodeURIComponent(opportunityId)}/comparison`,
    { method: 'POST' },
  );
}

export function fetchWorkspaceDirectories(options?: {
  root?: string;
  query?: string;
  showHidden?: boolean;
}): Promise<WorkspaceDirectoryList> {
  const params = new URLSearchParams();
  if (options?.root) params.set('root', options.root);
  if (options?.query) params.set('q', options.query);
  if (options?.showHidden) params.set('show_hidden', 'true');
  const query = params.toString();
  return request<WorkspaceDirectoryList>(
    `/api/workspaces/directories${query ? `?${query}` : ''}`,
  );
}

export function fetchWorkspaceRoots(): Promise<WorkspaceRoot[]> {
  return request<WorkspaceRoot[]>('/api/workspaces/roots');
}

export function createWorkspaceDirectory(
  parent: string,
  name: string,
): Promise<WorkspaceDirectory> {
  return request<WorkspaceDirectory>('/api/workspaces/directories', {
    method: 'POST',
    body: JSON.stringify({ parent, name }),
  });
}

export function createProject(data: {
  name: string;
  path?: string;
  emoji?: string;
  color?: string;
}): Promise<Project> {
  return request<Project>('/api/projects', {
    method: 'POST',
    body: JSON.stringify({
      name: data.name,
      path: data.path || null,
      emoji: data.emoji ?? '',
      color: data.color ?? '#246FE0',
    }),
  });
}

export function updateProject(
  projectId: string,
  data: {
    name?: string;
    path?: string;
  },
): Promise<Project> {
  return request<Project>(`/api/projects/${projectId}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export function deleteProject(projectId: string): Promise<void> {
  return request<void>(`/api/projects/${projectId}`, { method: 'DELETE' });
}

export function fetchTasks(projectId: string): Promise<Task[]> {
  return request<Task[]>(`/api/tasks?project_id=${encodeURIComponent(projectId)}`);
}

export function fetchTask(taskId: string): Promise<Task> {
  return request<Task>(`/api/tasks/${encodeURIComponent(taskId)}`);
}

export function fetchTaskQuality(taskId: string): Promise<TaskQuality> {
  return request<TaskQuality>(
    `/api/tasks/${encodeURIComponent(taskId)}/quality`,
  );
}

export function fetchQualitySummary(
  projectId: string,
): Promise<QualitySummary> {
  return request<QualitySummary>(
    `/api/projects/${encodeURIComponent(projectId)}/quality/summary`,
  );
}

export function saveQualityContract(
  taskId: string,
  data: {
    expected_revision: number;
    desired_outcome: string;
    risk_level: QualityRisk;
    stage: Exclude<QualityStage, 'review' | 'done'>;
    acceptance_checks: AcceptanceCheck[];
    required_skills: string[];
    human_review_required: boolean;
  },
): Promise<TaskQuality> {
  return request<TaskQuality>(
    `/api/tasks/${encodeURIComponent(taskId)}/quality/contract`,
    { method: 'PUT', body: JSON.stringify(data) },
  );
}

export function transitionTaskQuality(
  taskId: string,
  stage: Exclude<QualityStage, 'done'>,
  reason: string,
): Promise<TaskQuality> {
  return request<TaskQuality>(
    `/api/tasks/${encodeURIComponent(taskId)}/quality/transition`,
    {
      method: 'POST',
      body: JSON.stringify({ stage, actor: 'human:owner', reason }),
    },
  );
}

export function submitTaskEvidence(
  taskId: string,
  data: {
    contract_revision: number;
    producer: string;
    summary: string;
    checks: EvidenceCheck[];
  },
): Promise<TaskQuality> {
  return request<TaskQuality>(
    `/api/tasks/${encodeURIComponent(taskId)}/quality/evidence`,
    { method: 'POST', body: JSON.stringify(data) },
  );
}

export function reviewTaskEvidence(
  taskId: string,
  receiptId: string,
  data: {
    decision: 'accepted' | 'rejected';
    reviewer: string;
    reason: string;
    rework_stage?: 'execute' | 'verify';
    lesson?: {
      category: 'success' | 'failure' | 'correction' | 'workflow';
      statement: string;
    };
  },
): Promise<TaskQuality> {
  return request<TaskQuality>(
    `/api/tasks/${encodeURIComponent(taskId)}/quality/evidence/${encodeURIComponent(receiptId)}/review`,
    { method: 'POST', body: JSON.stringify(data) },
  );
}

export function createTask(
  projectId: string | undefined,
  title: string,
  description = '',
  options: {
    priority?: number;
    due_date?: string | null;
    execution_prompt?: string;
  } = {},
): Promise<Task> {
  return request<Task>('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({
      ...(projectId ? { project_id: projectId } : {}),
      title,
      description,
      priority: options.priority ?? 4,
      due_date: options.due_date ?? null,
      execution_prompt: options.execution_prompt ?? '',
    }),
  });
}

export function updateTask(
  taskId: string,
  data: {
    title?: string;
    description?: string;
    project_id?: string;
    priority?: number;
    due_date?: string | null;
    is_done?: boolean;
    workflow_state?: import('./types').WorkflowState;
    execution_prompt?: string;
  },
): Promise<Task> {
  const manualCompletion = Object.keys(data).length === 1 && (typeof data.is_done === 'boolean' || data.workflow_state === 'done' || data.workflow_state === 'todo');
  return request<Task>(`/api/tasks/${taskId}${manualCompletion ? '/owner-completion' : ''}`, {
    method: 'PUT',
    body: JSON.stringify(manualCompletion ? { is_done: data.is_done ?? (data.workflow_state === 'done') } : data),
  });
}

export function launchTaskResearch(
  taskId: string,
): Promise<TaskResearchLaunch> {
  return request<TaskResearchLaunch>(
    `/api/tasks/${encodeURIComponent(taskId)}/research-launch`,
    { method: 'POST' },
  );
}

export function sendTaskResearchSessionInput(
  taskId: string,
  text: string,
): Promise<TaskResearchSessionInputResult> {
  return request<TaskResearchSessionInputResult>(
    `/api/tasks/${encodeURIComponent(taskId)}/research-session/input`,
    {
      method: 'POST',
      body: JSON.stringify({ text }),
    },
  );
}

export function restoreTaskWorkspace(taskId: string): Promise<Task> {
  return request<Task>(
    `/api/tasks/${encodeURIComponent(taskId)}/workspace-restore`,
    { method: 'POST' },
  );
}

export function startProjectSerialQueue(
  projectId: string,
  taskIds: string[],
): Promise<SerialQueue> {
  return request<SerialQueue>(
    `/api/projects/${encodeURIComponent(projectId)}/execution-queue`,
    {
      method: 'POST',
      body: JSON.stringify({ task_ids: taskIds }),
    },
  );
}

export function cancelProjectSerialQueue(
  projectId: string,
): Promise<SerialQueue> {
  return request<SerialQueue>(
    `/api/projects/${encodeURIComponent(projectId)}/execution-queue`,
    { method: 'DELETE' },
  );
}

export interface CompletedTaskDeleteResult {
  deleted_task_ids: string[];
  skipped_task_ids: string[];
}

export function deleteCompletedTasks(
  taskIds: string[],
): Promise<CompletedTaskDeleteResult> {
  return request<CompletedTaskDeleteResult>('/api/tasks/completed/delete', {
    method: 'POST',
    body: JSON.stringify({ task_ids: taskIds }),
  });
}

export function deleteTask(taskId: string): Promise<void> {
  return request<void>(`/api/tasks/${taskId}`, { method: 'DELETE' });
}

export function fetchWorkspace(projectId: string): Promise<WorkspaceStatus> {
  return request<WorkspaceStatus>(`/api/projects/${projectId}/workspace`);
}










export function fetchSystemHealthSummary(
  refresh = false,
): Promise<SystemHealthSummary> {
  return request<SystemHealthSummary>(
    `/api/system-health/summary${refresh ? '?refresh=true' : ''}`,
  );
}

export function fetchSystemHealthHistory(
  metric: 'cpu' | 'memory' | 'load' | 'network' | 'disk_io',
  options?: { seconds?: number; points?: number },
): Promise<SystemHealthHistory> {
  const params = new URLSearchParams({ metric });
  if (options?.seconds) params.set('seconds', String(options.seconds));
  if (options?.points) params.set('points', String(options.points));
  return request<SystemHealthHistory>(
    `/api/system-health/history?${params.toString()}`,
  );
}

export function fetchSystemHealthAlerts(
  refresh = false,
): Promise<SystemHealthAlerts> {
  return request<SystemHealthAlerts>(
    `/api/system-health/alerts${refresh ? '?refresh=true' : ''}`,
  );
}

export function fetchSystemHealthWorkloads(
  refresh = false,
): Promise<SystemHealthWorkloads> {
  return request<SystemHealthWorkloads>(
    `/api/system-health/workloads${refresh ? '?refresh=true' : ''}`,
  );
}

export function createTmuxSession(
  projectId: string,
  name?: string,
  mode: 'shell' | 'claude' | 'codex' = 'shell',
): Promise<TmuxSession> {
  return request<TmuxSession>(`/api/projects/${projectId}/tmux/sessions`, {
    method: 'POST',
    body: JSON.stringify({ mode, name: name?.trim() || null }),
  });
}

export function sendTmuxInput(projectId: string, sessionName: string, text: string): Promise<unknown> {
  return request(`/api/projects/${projectId}/tmux/sessions/${encodeURIComponent(sessionName)}/input`, {
    method: 'POST',
    body: JSON.stringify({ text, enter: true }),
  });
}

/** Dolphin Desktop: which agent CLIs this host has, and how to install the rest. */
export type AgentCli = {
  agent: 'claude' | 'codex';
  name: string;
  found: boolean;
  install_command: string | null;
  install_then_start: string | null;
  install_hint: string | null;
};

export function getAgentClis(): Promise<AgentCli[]> {
  return request<AgentCli[]>('/api/desktop/agents');
}

export function renameTmuxSession(
  projectId: string,
  sessionName: string,
  name: string,
): Promise<TmuxSession> {
  return request<TmuxSession>(
    `/api/projects/${projectId}/tmux/sessions/${encodeURIComponent(sessionName)}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ name: name.trim() }),
    },
  );
}

export function closeTmuxSession(
  projectId: string,
  sessionName: string,
): Promise<void> {
  return request<void>(
    `/api/projects/${projectId}/tmux/sessions/${encodeURIComponent(sessionName)}`,
    { method: 'DELETE' },
  );
}

export function fetchTmuxSnapshot(
  projectId: string,
  sessionName: string,
  lines = 2000,
): Promise<TmuxSnapshot> {
  return request<TmuxSnapshot>(
    `/api/projects/${projectId}/tmux/sessions/${encodeURIComponent(
      sessionName,
    )}/snapshot?lines=${encodeURIComponent(String(lines))}`,
  );
}


export async function resolveTerminalPaths(
  projectId: string,
  sessionName: string | null,
  candidates: string[],
  signal?: AbortSignal,
): Promise<TerminalPathResolution[]> {
  const response = await request<{ paths: TerminalPathResolution[] }>(
    `/api/projects/${encodeURIComponent(projectId)}/terminal/paths/resolve`,
    {
      method: 'POST',
      body: JSON.stringify({ session_name: sessionName, candidates }),
      signal,
    },
  );
  return response.paths;
}


/* A plain URL rather than a fetch: the browser streams the response itself,
   with its own progress UI, instead of this app buffering a whole file in
   memory to hand back a blob. */
export function workspaceFileDownloadUrl(path: string): string {
  return withToken(`${API_BASE}/api/workspaces/file?path=${encodeURIComponent(path)}`);
}


export function dispatchTodoToCodex(
  projectId: string,
  taskId: string,
  mode: 'start' | 'queue',
  sessionName?: string,
): Promise<{ session_name: string; task_count: number; message: string }> {
  return request<{ session_name: string; task_count: number; message: string }>(
    `/api/projects/${projectId}/codex/todo-dispatch`,
    {
      method: 'POST',
      body: JSON.stringify({
        session_name: sessionName ?? null,
        task_id: taskId,
        mode,
      }),
    },
  );
}


export function tmuxStreamUrl(projectId: string, sessionName: string): string {
  return withToken(`${WS_BASE}/api/projects/${projectId}/tmux/sessions/${encodeURIComponent(
    sessionName,
  )}/stream`);
}

export async function uploadTmuxAttachment(
  projectId: string,
  sessionName: string,
  file: Blob,
  originalName: string,
  contentType: string,
  signal?: AbortSignal,
): Promise<TmuxAttachment> {
  const response = await fetch(
    `${API_BASE}/api/projects/${encodeURIComponent(
      projectId,
    )}/tmux/sessions/${encodeURIComponent(sessionName)}/attachments`,
    {
      method: 'POST',
      headers: {
        ...authHeaders(),
        'Content-Type': contentType,
        'X-Dolphin-Attachment-Upload': '1',
        'X-Dolphin-Attachment-Name': encodeURIComponent(originalName),
      },
      body: file,
      signal,
    },
  );

  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const payload = await response.json();
      message = payload.detail ?? message;
    } catch {
      // Keep the HTTP status message.
    }
    throw new Error(message);
  }

  return (await response.json()) as TmuxAttachment;
}


export interface DictationStatus {
  available: boolean;
  ready: boolean;
  loading?: boolean;
  status: string;
  detail?: string;
  engine?: string;
  model?: string;
  device?: string;
  last_error?: string | null;
}

export interface DictationTranscript {
  text: string;
  language: string | null;
  language_probability?: number | null;
  engine: string;
  model: string;
  device: string;
  duration_ms: number;
  preview?: boolean;
}

export function fetchDictationStatus(): Promise<DictationStatus> {
  return request<DictationStatus>('/api/dictation/status');
}

export async function transcribeDictation(
  audio: Blob,
  filename: string,
  options?: {
    preview?: boolean;
    signal?: AbortSignal;
  },
): Promise<DictationTranscript> {
  const response = await fetch(`${API_BASE}/api/dictation/transcribe`, {
    method: 'POST',
    headers: {
      ...authHeaders(),
      'Content-Type': audio.type || 'application/octet-stream',
      'X-Audio-Filename': filename,
      ...(options?.preview ? { 'X-Dictation-Mode': 'preview' } : {}),
    },
    body: audio,
    signal: options?.signal,
  });

  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const payload = await response.json();
      message = payload.detail ?? message;
    } catch {
      // Keep the HTTP status message.
    }
    throw new Error(message);
  }

  return (await response.json()) as DictationTranscript;
}

export function fetchNotifications(limit = 50): Promise<NotificationList> {
  return request<NotificationList>(`/api/notifications?limit=${limit}`);
}

export function markNotificationsRead(
  target: { ids: string[] } | { all: true },
): Promise<{ unread_count: number }> {
  return request<{ unread_count: number }>('/api/notifications/read', {
    method: 'POST',
    body: JSON.stringify(target),
  });
}

export const notificationStreamUrl = withToken(`${API_BASE}/api/notifications/stream`);
