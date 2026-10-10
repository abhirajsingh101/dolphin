import { DndContext, MouseSensor, TouchSensor, KeyboardSensor, useSensor, useSensors, closestCenter } from '@dnd-kit/core';
import { SortableContext, useSortable, arrayMove, horizontalListSortingStrategy, sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { ReactNode } from 'react';
import { Fragment, Suspense, lazy, useEffect, useLayoutEffect, useState, useRef } from 'react';
import { animate, AnimatePresence, MotionConfig, motion, useReducedMotion } from 'motion/react';
import { Group, Panel, Separator, usePanelRef } from 'react-resizable-panels';
import GlassSessionWindow from './GlassSessionWindow';
import GlassProjectTasks from './GlassProjectTasks';
import GlassConversations from './GlassConversations';
import GlassChatTabs, { useChatTabs, useTabState, useTabRef } from './GlassChatTabs';
import AgentSetupPrompt from './AgentSetupPrompt';
import BrainStatus from './BrainStatus';
import UpdateNotice from './UpdateNotice';
const ProjectPickerDialog = lazy(() => import('./ProjectPickerDialog'));
const NewSessionDialog = lazy(() => import('./NewSessionDialog'));
const RemoveProjectDialog = lazy(() => import('./RemoveProjectDialog'));
const DesktopStart = lazy(() => import('./DesktopStart'));
import NotificationBell from './NotificationBell';
import {
  ArrowUp,
  ChevronDown,
  Folder,
  FolderMinus,
  Search,
  Plus,
  Sun,
  Moon,
  Terminal,
  X,
  Activity,
  ArrowUpRight,
  PanelLeft,
} from 'lucide-react';
import {
  fetchControlCenter,
  createProject,
  createTmuxSession,
  sendTmuxInput,
  request,
  DolphinApiError,
} from './api';
import type { SessionChoice } from './NewSessionDialog';
import { applyTheme, persistTheme, readStoredTheme } from './theme';
import type {
  ControlCenterProject,
  ControlCenterSession,
} from './types';
import './glass.css';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import CommandPalette from './CommandPalette';
import DolphinIcon from './DolphinIcon';
import type { PaletteItem } from './commandPaletteModel';
import { isTerminalLikeTarget } from './shortcutTarget';
type DashboardContext = { open_windows: { project_id: string; session_name: string; minimized: boolean; tab_hidden?: boolean }[]; pinned_sessions: { project_id: string; session_name: string }[]; focused_session: { project_id: string; session_name: string } | null };
type Target = { projectId: string; projectName: string; sessionName: string };
type ToolActivity = { id: string; tool: string; status: string; arguments: Record<string, unknown>; result: unknown };
type Message = { id: string; created_at?: string; role: 'user' | 'assistant'; text: string; payload?: { work_summary_receipt?: string; engine?: { provider: string; model: string; fallback: boolean } | null; uncertainty_note?: string | null; tool_activity?: ToolActivity[] } };
type TrackedWork = { id: string; project_id: string; session_name: string; state: string; finished_at: string | null; summary_status?: string | null };
type Thread = { id: string; title: string };
const key = (t: Target) => JSON.stringify([t.projectId, t.sessionName]);
function status(s: ControlCenterSession) {
  return s.observation_state === 'degraded'
    ? 'Status unavailable'
    : s.has_recent_activity
      ? 'Recent activity'
      : s.is_codex_running
        ? 'Agent connected'
        : s.attached
          ? 'Attached'
          : 'Idle';
}
function FocusItem({ id, selected, activity, label, onOpen, onUnpin, children }: { id: string; selected: boolean; activity: boolean; label: string; onOpen: () => void; onUnpin: () => void; children: ReactNode }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id });
  return <div ref={setNodeRef} data-activity={activity} className={`glass-focus-item ${selected ? 'selected' : ''} ${isDragging ? 'dragging' : ''}`}
    style={{ transform: CSS.Transform.toString(transform), transition, zIndex: isDragging ? 2 : undefined }}>
    <button ref={setActivatorNodeRef} {...attributes} {...listeners} aria-label={`Open focused ${label}`} title={label} onClick={onOpen}>{children}</button>
    <button aria-label={`Unpin ${label}`} onClick={onUnpin}><X size={12} /></button>
  </div>;
}
/** `desktop`: Dolphin Desktop's build, which has no Missions or legacy views
    but does have System Health. */
/** Dolphin Desktop: the machine this window is connected to. */
const desktopHost = typeof window === 'undefined'
  ? undefined
  : (window as { dolphinDesktop?: { config?: { host?: string } } }).dolphinDesktop?.config?.host;

export default function GlassWorkspace({ desktop = false, renderSignals }: {
  desktop?: boolean;
  /** The web app's suggestion tray, shown above the composer. The desktop app has none. */
  renderSignals?: (onDiscuss: (text: string) => void) => ReactNode;
} = {}) {
  // Dolphin Desktop has no legacy project page, so + opens the folder picker
  // here. It browses the connected machine, which works for SSH hosts too.
  const [pickingProject, setPickingProject] = useState(false);
  const [choosingSession, setChoosingSession] = useState<ControlCenterProject | null>(null);
  const [removingProject, setRemovingProject] = useState<ControlCenterProject | null>(null);
  const [restored] = useState(() => {
    const empty = { windows: [] as Target[], minimized: [] as string[], active: null as Target | null };
    try {
      const saved = JSON.parse(localStorage.getItem('dolphin.glass.windows') ?? 'null');
      if (!saved || !Array.isArray(saved.windows)) return empty;
      const seen = new Set<string>();
      const windows: Target[] = saved.windows.filter((t: Target) => {
        if (!t || !['projectId', 'projectName', 'sessionName'].every(k =>
          typeof t[k as keyof Target] === 'string' && t[k as keyof Target].trim())) return false;
        if (seen.has(key(t))) return false;
        seen.add(key(t));
        return true;
      }).slice(0, 100);
      return { windows,
        minimized: windows.filter(t => Array.isArray(saved.minimized) && saved.minimized.includes(key(t))).map(key),
        active: windows.find(t => key(t) === saved.active) ?? null };
    } catch { return empty; }
  });

  const sensors = useSensors(useSensor(MouseSensor, { activationConstraint: { distance: 8 } }), useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const [projects, setProjects] = useState<ControlCenterProject[]>([]),
    [query, setQuery] = useState(''),
    [focus, setFocus] = useState<Target[]>(() => {
      try {
        const saved: unknown = JSON.parse(
          localStorage.getItem('dolphin.glass.focus') ?? '[]',
        );
        return Array.isArray(saved)
          ? saved
              .filter(
                (t): t is Target =>
                  t &&
                  ['projectId', 'projectName', 'sessionName'].every(
                    (k) => typeof t[k] === 'string',
                  ),
              )
              .slice(0, 100)
          : [];
      } catch {
        return [];
      }
    }),
    [active, setActive] = useState<Target | null>(restored.active);
  const [sidebarTab, setSidebarTab] = useState<'projects' | 'tasks'>('projects');
  const [windows, setWindows] = useState<Target[]>(restored.windows);
  const [minimized, setMinimized] = useState<string[]>(restored.minimized);
  const [projectTabs, setProjectTabs] = useState<Record<string, string>>(() => {
    try { const saved = JSON.parse(localStorage.getItem('dolphin.glass.project-tabs') || '{}');
      return saved && typeof saved === 'object' && !Array.isArray(saved) ? Object.fromEntries(Object.entries(saved).filter(([, value]) => typeof value === 'string')) as Record<string, string> : {};
    } catch { return {}; }
  });
  useEffect(() => { if (active) setProjectTabs(old => ({ ...old, [active.projectId]: active.sessionName })); }, [active]);
  useEffect(() => { try { localStorage.setItem('dolphin.glass.project-tabs', JSON.stringify(projectTabs)); } catch { /* Storage is optional. */ } }, [projectTabs]);
  const projectWindows = Array.from(new Set(windows.map(target => target.projectId))).map(projectId => {
    const sessions = windows.filter(target => target.projectId === projectId);
    const selected = sessions.find(target => target.sessionName === (active?.projectId === projectId ? active.sessionName : projectTabs[projectId])) || sessions[0];
    return { projectId, sessions, selected, collapsed: sessions.every(target => minimized.includes(key(target))) };
  });
  // Fullscreen belongs to the project window, not to one terminal, so its tab
  // strip stays reachable and switching tabs keeps the window fullscreen.
  const [fullscreenProject, setFullscreenProject] = useState<string | null>(null);
  const fullscreenGroup = projectWindows.find(group => group.projectId === fullscreenProject);
  useEffect(() => {
    if (fullscreenProject && (!fullscreenGroup || fullscreenGroup.collapsed)) setFullscreenProject(null);
  }, [fullscreenProject, fullscreenGroup]);
  useEffect(() => {
    if (!fullscreenProject) return;
    const exit = (event: KeyboardEvent) => {
      // Escape inside the terminal belongs to the program running there.
      if (event.key !== 'Escape' || (event.target instanceof Element
        && event.target.closest('.terminal-host, .xterm, input, textarea, select, [contenteditable="true"]'))) return;
      setFullscreenProject(null);
    };
    window.addEventListener('keydown', exit);
    return () => window.removeEventListener('keydown', exit);
  }, [fullscreenProject]);

  useEffect(() => {
    try {
      localStorage.setItem('dolphin.glass.windows', JSON.stringify({ windows, minimized, active: active ? key(active) : null }));
    } catch { /* The workspace remains usable when browser storage is unavailable. */ }
  }, [windows, minimized, active]);
  const windowStack = useRef<HTMLDivElement>(null);
  const [scrollTarget, setScrollTarget] = useState<{ key: string } | null>(restored.active ? { key: key(restored.active) } : null);
  const rightPanel = usePanelRef();
  const [revealWindow, setRevealWindow] = useState(0);
  const lastSplit = useRef(38);
  const reduceMotion = useReducedMotion();
  useEffect(() => {
    if (!scrollTarget) return;
    const frame = requestAnimationFrame(() => {
      const stack = windowStack.current;
      const window = Array.from(stack?.children ?? []).find(element => (element as HTMLElement).dataset.sessionKey === scrollTarget.key);
      if (!stack || !window) return;
      stack.scrollTo({ top: stack.scrollTop + window.getBoundingClientRect().top - stack.getBoundingClientRect().top,
        behavior: reduceMotion ? 'instant' : 'smooth' });
    });
    return () => cancelAnimationFrame(frame);
  }, [scrollTarget, reduceMotion]);
  const [narrow, setNarrow] = useState(() => matchMedia('(max-width: 850px)').matches);
  useEffect(() => {
    const media = matchMedia('(max-width: 850px)');
    const change = () => setNarrow(media.matches);
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  const hasWindows = windows.some((target) => !minimized.includes(key(target)));
  useEffect(() => {
    const panel = rightPanel.current;
    if (!panel) return;
    const start = panel.getSize().asPercentage;
    if (!hasWindows && start > 0) lastSplit.current = Math.min(90, Math.max(25, start));
    const control = animate(start, hasWindows ? lastSplit.current : 0, {
      duration: reduceMotion ? 0 : 0.32,
      ease: [0.22, 1, 0.36, 1],
      onUpdate: (size) => panel.resize(`${size}%`),
    });
    return () => control.stop();
  }, [hasWindows, reduceMotion, rightPanel, revealWindow]);
  function closeWindow(target: Target) {
    setMinimized((ids) => ids.filter((id) => id !== key(target)));
    setWindows((items) => items.filter((item) => key(item) !== key(target)));
    setActive((current) => current && key(current) === key(target) ? null : current);
  }
  function focusChat() {
    // Focusing chat must not close the terminal views described in its context.
    setActive(null);
    composerInput.current?.focus();
  }
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const sessionTargets = projects.flatMap((p) =>
    p.sessions.map((s) => ({
      projectId: p.id,
      projectName: p.name,
      sessionName: s.name,
    })),
  );
  const paletteItems: PaletteItem[] = [
    {
      id: 'dolphin',
      kind: 'action',
      label: 'Open Dolphin chat',
      hint: 'Your assistant',
    },
    ...sessionTargets.map((t) => ({
      id: key(t),
      kind: 'session' as const,
      label: `${t.projectName} / ${t.sessionName}`,
      hint: focus.some((f) => key(f) === key(t)) ? 'In Focus' : 'Open and pin',
    })),
  ];
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (isTerminalLikeTarget(event.target as HTMLElement)) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((value) => !value);
      }
      if (event.key === 'Escape') setSidebarOpen(false);
    };
    window.addEventListener('keydown', keyboard);
    return () => window.removeEventListener('keydown', keyboard);
  }, []);
  useEffect(() => {
    document.title = active
      ? `${active.sessionName} · ${active.projectName} — Dolphin`
      : 'Dolphin — Workspace';
  }, [active]);
  const chatTabs = useChatTabs();
  const tabId = chatTabs.active;
  const retry = useTabRef<{ text: string; thread: string; id: string; dashboard_context: DashboardContext } | null>(
    tabId, null,
  );
  const [pending, setPending, tabPending, setPendingFor] = useTabState(tabId, false);
  const [optimistic, setOptimistic] = useTabState<{ text: string; previousIds: string[] } | null>(tabId, null);
  const [failedMessage, setFailedMessage] = useTabState<string | null>(tabId, null);
  const [theme, setTheme] = useState(() => applyTheme(readStoredTheme())),
    [error, setError] = useTabState(tabId, ''),
    [threads, setThreads] = useState<Thread[]>([]),
    [thread, setThread, tabThreads, setThreadFor] = useTabState(tabId, '', 'dolphin.glass.chat-thread'),
    [messages, setMessages, , setMessagesFor] = useTabState<Message[]>(tabId, []),
    [draft, setDraft] = useTabState(tabId, '', 'dolphin.glass.chat-draft'),
    [busy, setBusy, tabBusy] = useTabState(tabId, false),
    [creating, setCreating] = useState(false);
  const [toolActivity, setToolActivity] = useTabState<ToolActivity[]>(tabId, []);
  const [trackedWork, setTrackedWork, , setTrackedWorkFor] = useTabState<TrackedWork[]>(tabId, []);
  const [closingWork, setClosingWork] = useTabState(tabId, '');
  const [trackingError, setTrackingError] = useTabState(tabId, false);
  useEffect(() => {
    setTrackedWork([]);
    setTrackingError(false);
    if (!thread) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const work = await request<TrackedWork[]>(`/api/dolphin/threads/${encodeURIComponent(thread)}/work`);
        if (alive && Array.isArray(work)) { setTrackedWork(work); setTrackingError(false); }
      } catch { if (alive) setTrackingError(true); }
      if (alive) timer = setTimeout(poll, 4000);
    }
    void poll();
    return () => { alive = false; clearTimeout(timer); };
  }, [tabId, thread]);
  async function closeTrackedWork(work: TrackedWork) {
    setClosingWork(work.id);
    try {
      await request(`/api/dolphin/threads/${encodeURIComponent(thread)}/work/${encodeURIComponent(work.id)}/close`, { method: 'POST' });
      setTrackedWork(items => items.map(item => item.id === work.id ? { ...item, state: 'closed' } : item));
      const target = { projectId: work.project_id, projectName: '', sessionName: work.session_name };
      closeWindow(target);
      setFocus(items => items.filter(item => key(item) !== key(target)));
      void refresh();
    } catch (error) { setError(String(error)); }
    finally { setClosingWork(''); }
  }
  const [liveReply, setLiveReply] = useTabState(tabId, '');
  useEffect(() => {
    setLiveReply('');
    if (!thread || !(busy || pending)) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const progress = await request<{ turn_id?: string; text?: string }>(`/api/dolphin/threads/${encodeURIComponent(thread)}/progress`);
        if (alive && progress.turn_id && typeof progress.text === 'string') setLiveReply(progress.text);
      } catch { /* Saved conversation polling still recovers the final reply. */ }
      if (alive) timer = setTimeout(poll, 150);
    }
    void poll();
    return () => { alive = false; clearTimeout(timer); };
  }, [tabId, thread, busy, pending]);
  useEffect(() => {
    setToolActivity([]);
    if (!thread || !(busy || pending)) return;
    let alive = true;
    const poll = async () => {
      try {
        const activity = await request<ToolActivity[]>(`/api/dolphin/threads/${encodeURIComponent(thread)}/activity`);
        if (alive && Array.isArray(activity)) setToolActivity(activity);
      } catch { /* The final response still carries durable receipts. */ }
    };
    void poll();
    const timer = setInterval(poll, 1500);
    return () => { alive = false; clearInterval(timer); };
  }, [tabId, thread, busy, pending]);
  function renderActivity(items: ToolActivity[]) {
    return <div className="glass-tool-activity" aria-label="Dolphin tool activity">{items.map(item => {
      const project = projects.find(p => p.id === item.arguments.project_id);
      const result = item.result as { result?: { name?: string; session_name?: string; engine?: string } } | null;
      const sessionName = result?.result?.name || result?.result?.session_name || item.arguments.session_name;
      const tracked = trackedWork.find(work => work.id === item.id);
      const sessionAction = project && typeof sessionName === 'string' && result?.result
        && ['start_project_work', 'create_session', 'send_work', 'run_native_task'].includes(item.tool);
      return <div key={item.id}>
        {sessionAction && <div className="glass-session-receipt">
          <Terminal size={18} aria-hidden="true" />
          <span><strong>{project.name}</strong><span>{sessionName}</span><small>{tracked?.state === 'closed' ? 'Session closed' : tracked?.finished_at ? 'Agent finished its turn · work not independently verified' : tracked ? 'Tracking agent · no model tokens' : item.status === 'submitted' ? 'Task submitted · completion not yet verified' : item.status === 'unknown' ? 'Inspect session · startup not confirmed' : 'Session ready'}</small></span>
          <button disabled={tracked?.state === 'closed'} aria-label={`Open session ${project.name} / ${sessionName}`} onClick={() => open({ projectId: project.id, projectName: project.name, sessionName })}>Open session <ArrowUpRight size={14} /></button>
        </div>}
        <details>
        <summary><span>{item.tool.replace(/_/g, ' ')}</span><small data-status={item.status}>{item.status}</small></summary>
        {!sessionAction && project && typeof sessionName === 'string' && <button onClick={() => open({ projectId: project.id, projectName: project.name, sessionName })}>Open session</button>}
        <pre>{JSON.stringify(item.result, null, 2)}</pre>
      </details></div>;
    })}</div>;
  }
  useEffect(() => {
    try {
      localStorage.setItem('dolphin.glass.focus', JSON.stringify(focus));
    } catch {
      /* Storage is optional. */
    }
  }, [focus]);
  const conversation = useRef<HTMLDivElement>(null);
  const savedScroll = useTabRef(tabId, 0);
  const followTail = useTabRef(tabId, true);
  const composerInput = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const input = composerInput.current;
    if (!input) return;
    const fit = () => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 144)}px`; };
    fit();
    // Dragging the chat panel rewraps the draft, so refit on width changes too.
    let width = input.clientWidth;
    const observer = new ResizeObserver(() => { if (input.clientWidth !== width) { width = input.clientWidth; fit(); } });
    observer.observe(input);
    return () => observer.disconnect();
  }, [draft, active]);
  useLayoutEffect(() => {
    const element = conversation.current;
    if (!element) return;
    // Restore after content is committed but before paint, without CSS smooth
    // scrolling through the history. Readers retain their position in each tab.
    element.scrollTop = followTail.current && (messages.length || busy)
      ? element.scrollHeight : savedScroll.current;
  }, [tabId, messages, busy, optimistic, liveReply, trackedWork.map(work => `${work.id}:${work.state}`).join('|')]);
  const [inventoryAvailable, setInventoryAvailable] = useState<boolean | null>(
    null,
  );
  const refresh = () =>
    fetchControlCenter()
      .then((s) => {
        setProjects(s.projects);
        setInventoryAvailable(true);
      })
      .catch((e) => {
        setInventoryAvailable(false);
        setError(String(e));
      });
  useEffect(() => {
    void refresh();
    const timer = setInterval(refresh, 15000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    request<Thread[]>('/api/chief/threads')
      .then((ts) => {
        setThreads(ts);
        if (ts[0] && !thread && tabId === 'initial') setThread(ts[0].id);
      })
      .catch(() =>
        setError(
          'Conversation service unavailable. Check the backend connection and allowed origins.',
        ),
      );
  }, []);

  useEffect(() => {
    if (!thread) {
      setMessages([]);
      setPending(false);
      return;
    }
    let current = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const t = await request<{
          messages: Message[];
          pending_idempotency_keys: string[];
        }>(`/api/chief/threads/${encodeURIComponent(thread)}`);
        if (current) {
          setMessages(t.messages);
          setPending(t.pending_idempotency_keys.length > 0);
          if (t.pending_idempotency_keys.length || busy) timer = setTimeout(load, 2000);
        }
      } catch (e) {
        if (current) setError(String(e));
      }
    };
    void load();
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [tabId, thread, busy, trackedWork.filter(work => work.summary_status === 'completed').map(work => work.id).join('|')]);

  // Non-visible tabs keep receiving results, completion summaries and pending state.
  const lastRead = useRef<Record<string, string>>({});
  const [, setUnread, unreadTabs, setUnreadFor] = useTabState(tabId, false);
  useEffect(() => { lastRead.current[tabId] = messages[messages.length - 1]?.id || ''; setUnread(false); }, [tabId, messages]);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    async function pollBackground() {
      await Promise.all(chatTabs.tabs.filter(tab => tab.id !== tabId && tabThreads[tab.id]).map(async tab => {
        const id = tabThreads[tab.id];
        try {
          const [detail, work] = await Promise.all([
            request<{ messages: Message[]; pending_idempotency_keys: string[] }>(`/api/chief/threads/${encodeURIComponent(id)}`),
            request<TrackedWork[]>(`/api/dolphin/threads/${encodeURIComponent(id)}/work`),
          ]);
          if (!alive) return;
          setMessagesFor(tab.id, detail.messages);
          setPendingFor(tab.id, detail.pending_idempotency_keys.length > 0);
          if (Array.isArray(work)) setTrackedWorkFor(tab.id, work);
          const latest = detail.messages[messages.length - 1];
          if (lastRead.current[tab.id] === undefined) lastRead.current[tab.id] = latest?.id || '';
          else if (latest?.role === 'assistant' && latest.id !== lastRead.current[tab.id]) setUnreadFor(tab.id, true);
        } catch { /* Retry on the next background tick. */ }
      }));
      if (alive) timer = setTimeout(pollBackground, 5000);
    }
    void pollBackground();
    return () => { alive = false; clearTimeout(timer); };
  }, [tabId, chatTabs.tabs.map(tab => `${tab.id}:${tabThreads[tab.id] || ''}`).join('|')]);

  // Switching a window's own tab keeps the stack where it is; every other way
  // of opening a session brings its window to the top.
  function open(t: Target, { scroll = true }: { scroll?: boolean } = {}) {
    if ((rightPanel.current?.getSize().asPercentage ?? 0) < 1) setRevealWindow((value) => value + 1);
    setSidebarOpen(false);
    setError('');
    setFocus((old) => (old.some((x) => key(x) === key(t)) ? old : [...old, t]));
    setActive(t);
    if (scroll) setScrollTarget({ key: key(t) });
    setMinimized(ids => ids.filter(id => !windows.some(item => item.projectId === t.projectId && key(item) === id) && id !== key(t)));
    setWindows((old) => old.some((item) => key(item) === key(t)) ? old : [...old, t]);
  }
  async function create(project: ControlCenterProject, choice?: SessionChoice) {
    // Dolphin Desktop asks what to run first: an agent, an install, or a shell.
    if (desktop && !choice) {
      setChoosingSession(project);
      return;
    }
    setCreating(true);
    setError('');
    try {
      const s = await createTmuxSession(project.id, undefined, choice?.mode ?? 'shell');
      if (choice?.startup) await sendTmuxInput(project.id, s.name, choice.startup);
      await refresh();
      open({
        projectId: project.id,
        projectName: project.name,
        sessionName: s.name,
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setCreating(false);
    }
  }
  async function send(retryText?: string) {
    const text = (retryText ?? draft).trim();
    if (!text || busy || pending) return;
    if (!retryText || draft.trim() === text) setDraft('');
    setFailedMessage(null);
    setOptimistic({ text, previousIds: messages.map((message) => message.id) });
    followTail.current = true;
    setBusy(true);
    setError('');
    const identity = (target: Target) => ({ project_id: target.projectId, session_name: target.sessionName });
    const dashboard_context: DashboardContext = {
      open_windows: windows.map((target) => ({ ...identity(target), minimized: minimized.includes(key(target)), ...(projectWindows.find(group => group.projectId === target.projectId)?.selected.sessionName !== target.sessionName ? { tab_hidden: true } : {}) })),
      pinned_sessions: focus.map(identity),
      focused_session: active ? identity(active) : null,
    };
    try {
      let id = thread;
      if (!id) {
        const t = await request<Thread>('/api/chief/threads', {
          method: 'POST',
          body: JSON.stringify({ title: text.slice(0, 80).trim() }),
        });
        id = t.id;
        setThreads((ts) => [t, ...ts]);
        setThread(id);
      }
      if (
        !retry.current ||
        retry.current.text !== text ||
        retry.current.thread !== id
      )
        retry.current = { text, thread: id, id: crypto.randomUUID(), dashboard_context };
      const result = await request<{ status: string; display_text: string }>(
        `/api/dolphin/threads/${encodeURIComponent(id)}/turns`,
        {
          method: 'POST',
          headers: { 'Idempotency-Key': retry.current.id },
          body: JSON.stringify({ text, dashboard_context: retry.current.dashboard_context }),
        },
      );
      const detail = await request<{ messages: Message[] }>(
        `/api/chief/threads/${encodeURIComponent(id)}`,
      );
      setMessages(detail.messages);
      retry.current = null;
      void refresh();
      if (result.status === 'in_progress') setPending(true);
      if (result.status !== 'completed' && result.status !== 'in_progress') {
        setDraft((current) => current || text);
        setFailedMessage(text);
        setError(`Response ${result.status}. ${result.display_text}`);
      }
    } catch (e) {
      setDraft((current) => current || text);
      setFailedMessage(text);
      // Terminal model failures are persisted; replaying their key cannot regenerate.
      // Keep keys for ambiguous network failures to avoid duplicate accepted turns.
      if (e instanceof DolphinApiError && e.code?.startsWith('model_')) retry.current = null;
      setError(e instanceof DolphinApiError && e.code?.startsWith('model_')
        ? 'Dolphin could not complete this response. Your message is saved — retry when ready.'
        : 'Could not reach Dolphin. Your message is preserved; try sending again.');
    } finally {
      setOptimistic(null);
      setBusy(false);
    }
  }
  const visibleMessages = optimistic && !messages.some((message) =>
    message.role === 'user' && message.text === optimistic.text && !optimistic.previousIds.includes(message.id))
    ? [...messages, { id: 'sending', role: 'user' as const, text: optimistic.text }]
    : messages;
  // Insert completion events by their actual timestamp, with the receipt link
  // keeping a summary behind its completion even when timestamps are absent.
  const workAt = new Map<number, TrackedWork[]>();
  for (const work of trackedWork.filter(item => item.finished_at || item.state === 'unavailable')
    .sort((a, b) => (a.finished_at ?? '').localeCompare(b.finished_at ?? ''))) {
    const index = visibleMessages.findIndex((message: Message) =>
      message.payload?.work_summary_receipt === work.id ||
      !!(work.finished_at && message.created_at && Date.parse(/(?:Z|[+-]\d{2}:\d{2})$/i.test(message.created_at) ? message.created_at : message.created_at + 'Z') >= Date.parse(work.finished_at)));
    const position = index < 0 ? visibleMessages.length : index;
    workAt.set(position, [...(workAt.get(position) ?? []), work]);
  }
  function renderWorkUpdates(items: TrackedWork[]) {
    if (!items.length) return null;
    return (
              <div aria-live="polite" aria-label="Delegated work updates">
                {items.map(work => {
                  const project = projects.find(item => item.id === work.project_id);
                  return <div className="glass-session-receipt glass-work-update" key={work.id}>
                    <Terminal size={18} aria-hidden="true" />
                    <span><strong>{work.state === 'closed' ? 'Session closed' : work.finished_at ? 'Agent finished its turn' : 'Session unavailable'}</strong>
                      <span>{project?.name || 'Project'} / {work.session_name}</span>
                      <small>{work.summary_status === 'running' ? 'Preparing a short summary…' : work.summary_status === 'failed' || work.summary_status === 'unknown' ? 'Summary unavailable. Open the session to review its result.' : work.summary_status === 'completed' ? 'Summary added to this conversation.' : work.state === 'closed' ? 'Completion record kept.' : work.state === 'working' ? 'New work is running in this session.' : work.state === 'unavailable' ? 'No live session found. Completion cannot be verified.' : 'Review the result in the terminal. Work is not independently verified.'}</small>
                    </span>
                    {work.state !== 'closed' && work.state !== 'unavailable' && <>
                      <button onClick={() => open({ projectId: work.project_id, projectName: project?.name || 'Project', sessionName: work.session_name })}>Open session <ArrowUpRight size={14} /></button>
                      <button disabled={work.state !== 'stopped' || !!closingWork || trackingError} title="Terminate this completed agent session. Leave it open by taking no action." onClick={() => void closeTrackedWork(work)}>{closingWork === work.id ? 'Closing…' : 'Close session'}</button>
                    </>}
                  </div>;
                })}
              </div>
    );
  }
  const count = projects.reduce((n, p) => n + p.sessions.length, 0);
  return (
    <MotionConfig reducedMotion="user"><div className="glass-workspace" data-sidebar-open={sidebarOpen} data-sidebar-collapsed={sidebarCollapsed}>
      <CommandPalette
        items={paletteItems}
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onSelect={(item) => {
          if (item.id === 'dolphin') focusChat();
          else {
            const t = sessionTargets.find((t) => key(t) === item.id);
            if (t) open(t);
          }
        }}
      />
      {pickingProject && (
        <Suspense fallback={null}>
          <ProjectPickerDialog
            onClose={() => setPickingProject(false)}
            onPick={(path) => {
              setPickingProject(false);
              const name = path.replace(/\/+$/, '').split('/').pop() || path;
              createProject({ name, path })
                .then(() => refresh())
                .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
            }}
          />
        </Suspense>
      )}
      {removingProject && (
        <Suspense fallback={null}>
          <RemoveProjectDialog
            project={removingProject}
            onClose={() => setRemovingProject(null)}
            onRemoved={() => {
              const removed = removingProject.id;
              setRemovingProject(null);
              // Its windows and dock shortcuts go with it; the tmux sessions stay.
              setWindows((items) => items.filter((item) => item.projectId !== removed));
              setFocus((items) => items.filter((item) => item.projectId !== removed));
              setMinimized((ids) => ids.filter((id) => (JSON.parse(id) as string[])[0] !== removed));
              void refresh();
            }}
          />
        </Suspense>
      )}
      {choosingSession && (
        <Suspense fallback={null}>
          <NewSessionDialog
            projectName={choosingSession.name}
            onClose={() => setChoosingSession(null)}
            onChoose={(choice) => {
              const project = choosingSession;
              setChoosingSession(null);
              void create(project, choice);
            }}
          />
        </Suspense>
      )}
      <header className="glass-top">
        <button className="glass-desktop-sidebar-toggle" aria-label={sidebarCollapsed ? 'Expand projects' : 'Collapse projects'} aria-expanded={!sidebarCollapsed} aria-controls="glass-projects" onClick={() => setSidebarCollapsed((value) => !value)}><PanelLeft size={18} /></button>
        <button
          className="glass-sidebar-toggle"
          aria-label="Toggle projects"
          aria-expanded={sidebarOpen}
          aria-controls="glass-projects"
          onClick={() => setSidebarOpen((value) => !value)}
        >
          <PanelLeft size={19} />
        </button>
        <a className="glass-brand" href="#/workspace">
          <span className="dolphin-mark">
            <DolphinIcon />
          </span>
          Dolphin
        </a>
        {desktop && desktopHost && <span className="glass-host" title={`Working on ${desktopHost}`}>{desktopHost}</span>}
        {!desktop && <a className="glass-fleet-link" href="#/fleet">Missions</a>}
        <button
          className="glass-global-search"
          onClick={() => setPaletteOpen(true)}
          aria-label="Open command palette"
        >
          <Search size={15} />
          <span>Search projects, sessions, or jump to…</span>
          <kbd>⌘ K</kbd>
        </button>
        <span className="glass-connected">
          {inventoryAvailable && <i />}
          {inventoryAvailable
            ? `${count} sessions in view`
            : inventoryAvailable === false
              ? 'Backend unavailable'
              : 'Connecting…'}
        </span>
        <NotificationBell onOpen={open} />
        <button
          aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
          onClick={() => {
            const t = theme === 'light' ? 'dark' : 'light';
            persistTheme(t);
            setTheme(applyTheme(t));
          }}
        >
          {theme === 'light' ? <Moon size={18} /> : <Sun size={18} />}
        </button>
        {desktop ? (
          <a href="#/health" aria-label="System Health" title="System Health">
            <Activity size={18} />
          </a>
        ) : (
          <a href="#/" title="Back to Dolphin Tasks">
            <ArrowUpRight size={18} />
          </a>
        )}
      </header>
      {sidebarOpen && (
        <button
          className="glass-sidebar-scrim"
          aria-label="Dismiss project drawer"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <motion.aside id="glass-projects" className="glass-sidebar glass-surface" initial={false} animate={{ opacity: sidebarCollapsed && !narrow ? 0 : 1 }} transition={{ duration: 0.16 }}>
        <div className="glass-sidebar-tabs" role="tablist" aria-label="Sidebar view" onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const next = event.key === 'Home' ? 'projects' : event.key === 'End' ? 'tasks' : sidebarTab === 'projects' ? 'tasks' : 'projects';
          setSidebarTab(next);
          document.getElementById(`glass-${next}-tab`)?.focus();
        }}>
          <button role="tab" id="glass-projects-tab" tabIndex={sidebarTab === 'projects' ? 0 : -1} aria-selected={sidebarTab === 'projects'} aria-controls="glass-projects-panel" onClick={() => setSidebarTab('projects')}>Projects</button>
          <button role="tab" id="glass-tasks-tab" tabIndex={sidebarTab === 'tasks' ? 0 : -1} aria-selected={sidebarTab === 'tasks'} aria-controls="glass-tasks-panel" onClick={() => setSidebarTab('tasks')}>Tasks</button>
        </div>
        {sidebarTab === 'tasks' ? <div key="tasks" id="glass-tasks-panel" role="tabpanel" aria-labelledby="glass-tasks-tab" className="glass-sidebar-panel">
          {active ? <GlassProjectTasks key={active.projectId} projectId={active.projectId} projectName={active.projectName} sessionName={active.sessionName} /> : <p className="glass-task-empty">Select an open terminal window to see its project’s tasks.</p>}
        </div> : <div key="projects" id="glass-projects-panel" role="tabpanel" aria-labelledby="glass-projects-tab" className="glass-sidebar-panel">
        <div className="glass-section-title">
          Projects <span>{projects.length}</span>
          <button
            className="glass-close-projects"
            aria-label="Close projects"
            onClick={() => setSidebarOpen(false)}
          >
            <X size={15} />
          </button>
          {desktop ? (
            <button aria-label="Add a project" title="Open a folder as a project" onClick={() => setPickingProject(true)}>
              <Plus size={15} />
            </button>
          ) : (
            <a href="#/" aria-label="Manage projects">
              <Plus size={15} />
            </a>
          )}
        </div>
        <label className="glass-project-filter">
          <Search size={14} />
          <input
            aria-label="Filter projects and sessions"
            placeholder="Filter projects…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <div className="glass-tree">
          {inventoryAvailable === false && (
            <div className="glass-inventory-error">
              <p>Session inventory unavailable.</p>
              <button onClick={() => void refresh()}>Retry connection</button>
            </div>
          )}
          {desktop && inventoryAvailable && !projects.some((p) => p.path && !p.is_inbox) && (
            <Suspense fallback={null}>
              <DesktopStart
                onOpenFolder={() => setPickingProject(true)}
                onLink={(repo) => createProject({ name: repo.name, path: repo.path })
                  .then(() => refresh())
                  .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))}
              />
            </Suspense>
          )}
          {inventoryAvailable && projects.length === 0 && (
            <p className="glass-inventory-error">
              No projects yet. Use + to open your first project.
            </p>
          )}
          {inventoryAvailable &&
            projects.length > 0 &&
            !projects.some((p) =>
              `${p.name} ${p.sessions.map((s) => s.name).join(' ')}`
                .toLowerCase()
                .includes(query.toLowerCase()),
            ) && (
              <p className="glass-inventory-error">
                No sessions or projects match “{query}”.
              </p>
            )}
          {projects
            .filter((p) =>
              `${p.name} ${p.sessions.map((s) => s.name).join(' ')}`
                .toLowerCase()
                .includes(query.toLowerCase()),
            )
            .map((p) => (
              <details key={p.id} open>
                <summary>
                  <ChevronDown size={13} />
                  <Folder size={16} />
                  <strong>{p.name}</strong>
                  <small>{p.sessions.length}</small>
                  {!p.is_inbox && (
                    <button
                      type="button"
                      className="glass-project-remove"
                      aria-label={`Remove ${p.name} from Dolphin`}
                      title="Remove from Dolphin (the folder stays)"
                      onClick={(event) => { event.preventDefault(); event.stopPropagation(); setRemovingProject(p); }}
                    >
                      <FolderMinus size={14} />
                    </button>
                  )}
                </summary>
                <div className="glass-sessions">
                  {p.sessions.map((s) => (
                    <button
                      className={
                        active?.projectId === p.id &&
                        active.sessionName === s.name
                          ? 'selected'
                          : ''
                      }
                      key={s.name}
                      data-activity={s.observation_state !== 'degraded' && s.has_recent_activity}
                      aria-label={`Open ${p.name} / ${s.name}`}
                      onClick={() =>
                        open({
                          projectId: p.id,
                          projectName: p.name,
                          sessionName: s.name,
                        })
                      }
                    >
                      <Terminal size={15} />
                      <span>
                        {s.name}
                        <small>
                          <i className={s.has_recent_activity ? 'live' : ''} />
                          {status(s)}
                        </small>
                      </span>
                    </button>
                  ))}
                  <button
                    className="glass-new-session"
                    disabled={creating}
                    onClick={() => void create(p)}
                  >
                    <Plus size={13} />
                    New session
                  </button>
                </div>
              </details>
            ))}
        </div>
        </div>}
        <footer>
          <span>Everything in context.</span>
          <small>One place to keep moving.</small>
        </footer>
      </motion.aside>
      <Group className="glass-center" orientation={narrow ? 'vertical' : 'horizontal'} resizeTargetMinimumSize={{ coarse: 24, fine: 8 }}>
      <Panel id="dolphin-chat" defaultSize="100%" minSize="10%">
      <main className="glass-stage glass-surface">
        <header className="glass-stage-header glass-chat-toolbar">
          <div className="glass-stage-name" title="Chat across all projects">
            <h1>Chat</h1><span>Across all projects</span>
          </div>
        <GlassChatTabs controller={chatTabs} title={id => chatTabs.tabs.find(tab => tab.id === id)?.title || threads.find(item => item.id === tabThreads[id])?.title || 'New chat'} running={id => !!(tabBusy[id] || tabPending[id])} unread={id => !!unreadTabs[id]} />
          <div className="glass-chat-actions">
              <GlassConversations threads={threads} selected={thread} disabled={false} protectedIds={chatTabs.tabs.filter(tab => tabBusy[tab.id] || tabPending[tab.id]).map(tab => tabThreads[tab.id])} onSelect={id => {
                const existing = id && chatTabs.tabs.find(tab => tabThreads[tab.id] === id);
                const closed = id && chatTabs.closed.find(tab => tabThreads[tab.id] === id);
                if (existing) chatTabs.select(existing.id);
                else if (closed) chatTabs.reopen(closed.id);
                else { const tab = chatTabs.add(); setThreadFor(tab, id); }
              }} onDeleted={id => {
                setThreads(items => items.filter(item => item.id !== id));
                chatTabs.tabs.filter(tab => tabThreads[tab.id] === id).forEach(tab => { setThreadFor(tab.id, ''); chatTabs.close(tab.id); });
              }} />
            </div>
        </header>
        {error && (
          <div role="alert" className="glass-error">
            {error}
            {failedMessage && <button disabled={busy || pending} onClick={() => void send(failedMessage)}>Retry failed message</button>}
            <button aria-label="Dismiss error" onClick={() => setError('')}>
              <X size={14} />
            </button>
          </div>
        )}
            <div
              className="glass-conversation" id="dolphin-chat-panel" role="tabpanel" aria-label="Chat conversation"
              aria-live="polite"
              ref={conversation}
              onScroll={(event) => { const el = event.currentTarget; savedScroll.current = el.scrollTop; followTail.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}
            >
              {visibleMessages.length === 0 ? (
                <div className="glass-welcome">
                  <span className="dolphin-orb">
                    <DolphinIcon />
                  </span>
                  <p>One thought. Every possibility.</p>
                  <h2>What shall we work on?</h2>
                  <span>
                    Your projects, conversations, and terminals.
                    <br />
                    Together in one quiet workspace.
                  </span>
                  <div>
                    <button
                      onClick={() =>
                        setDraft('Give me an overview of my projects.')
                      }
                    >
                      Get an overview <ArrowUpRight size={14} />
                    </button>
                    <button
                      onClick={() =>
                        setDraft('Help me decide what to focus on next.')
                      }
                    >
                      Find my next focus <ArrowUpRight size={14} />
                    </button>
                  </div>
                </div>
              ) : (
                visibleMessages.map((m, index) => (
                  <Fragment key={m.id}>
                  {renderWorkUpdates(workAt.get(index) ?? [])}
                  <motion.article key={m.id} className={`glass-message ${m.role}`} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.16 }}>
                    {m.role === 'assistant' && (
                      <div className="glass-reply-mark">
                        <span className="dolphin-mark">
                          <DolphinIcon />
                        </span>
                        <small>Dolphin</small>
                      </div>
                    )}
                    <div>
                      {m.role === 'assistant' ? (
                        <>{m.payload?.engine && <small className="glass-engine-label" title={m.payload.engine.model}>{m.payload.engine.provider === 'claude' ? 'Claude Code' : 'Codex'}{m.payload.engine.fallback ? ' · fallback' : ''}</small>}{m.payload?.tool_activity && renderActivity(m.payload.tool_activity)}<Markdown remarkPlugins={[remarkGfm]} components={{ table: ({ children }) => <div className="glass-table-scroll" role="region" aria-label="Table, scroll horizontally if needed" tabIndex={0}><table>{children}</table></div> }}>{m.text}</Markdown>{m.payload?.uncertainty_note && <p className="glass-context-note">{m.payload.uncertainty_note}</p>}</>
                      ) : (
                        m.text
                      )}
                    </div>
                  </motion.article>
                  </Fragment>
                ))
              )}
              {trackingError && <p className="glass-context-note">Work tracking is temporarily unavailable. Retrying…</p>}
              {renderWorkUpdates(workAt.get(visibleMessages.length) ?? [])}
              {(busy || pending) && (
                <>
                  {renderActivity(toolActivity)}
                  {liveReply && visibleMessages[visibleMessages.length - 1]?.role !== 'assistant' && <div className="glass-message assistant glass-streaming" aria-label="Dolphin response in progress" aria-busy="true">
                    <div className="glass-reply-mark"><span className="dolphin-mark"><DolphinIcon /></span></div>
                    <Markdown remarkPlugins={[remarkGfm]} components={{ table: ({ children }) => <div className="glass-table-scroll" role="region" aria-label="Table, scroll horizontally if needed" tabIndex={0}><table>{children}</table></div> }}>{liveReply}</Markdown>
                  </div>}
                  <p role="status" className="glass-thinking">{liveReply ? 'Dolphin is writing…' : 'Dolphin is working…'}</p>
                </>
              )}
            </div>
            {desktop && <UpdateNotice />}
            <BrainStatus />
            {desktop && <AgentSetupPrompt />}
            {renderSignals?.((text) => { setDraft(text); composerInput.current?.focus(); })}
            <form
              className="glass-composer"
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              <textarea
                aria-label="Message Dolphin"
                placeholder="Ask Dolphin, or start something…"
                ref={composerInput}
                rows={1}
                maxLength={4000}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (
                    e.key === 'Enter' &&
                    !e.shiftKey &&
                    !e.nativeEvent.isComposing
                  ) {
                    e.preventDefault();
                    void send();
                  }
                }}
              />
              <div>
                <button
                  className="glass-send"
                  aria-label="Send message"
                  disabled={busy || pending || !draft.trim()}
                >
                  <ArrowUp size={19} />
                </button>
              </div>
            </form>
      </main>
      </Panel>
      <Separator className="glass-window-separator" aria-label="Resize chat and session windows" disabled={!hasWindows} style={{ visibility: hasWindows ? 'visible' : 'hidden', width: narrow ? undefined : (hasWindows ? 10 : 0), height: narrow ? (hasWindows ? 10 : 0) : undefined }} />
      <Panel id="dolphin-windows" panelRef={rightPanel} defaultSize="0%" minSize="0%" maxSize="90%">
        <div ref={windowStack} className="glass-window-stack" data-multiple={projectWindows.length > 1}>
          <AnimatePresence initial={false}>
            {projectWindows.map(group => <motion.section layout="position" key={group.projectId} className="glass-session-window glass-surface" data-session-key={key(group.selected)} data-project-id={group.projectId} data-active={active?.projectId === group.projectId} data-fullscreen={fullscreenProject === group.projectId || undefined} initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 12 }} transition={{ duration: 0.22 }}>
              {group.sessions.map(target => <div key={key(target)} className="glass-project-terminal" hidden={key(target) !== key(group.selected)}>
                <GlassSessionWindow target={target} visible={key(target) === key(group.selected)} collapsed={group.collapsed}
                  fullscreen={fullscreenProject === group.projectId} onToggleFullscreen={() => setFullscreenProject(current => current === group.projectId ? null : group.projectId)}
                  creating={creating} onNewSession={() => { const project = projects.find(item => item.id === group.projectId); if (project) void create(project); }}
                  tabs={group.sessions.length > 1 ? <div className="glass-terminal-tabs" role="tablist" aria-label={`Terminal tabs for ${target.projectName}`} onKeyDown={event => {
                    const index = group.sessions.findIndex(item => key(item) === key(group.selected));
                    const next = event.key === 'ArrowRight' ? (index + 1) % group.sessions.length : event.key === 'ArrowLeft' ? (index - 1 + group.sessions.length) % group.sessions.length : event.key === 'Home' ? 0 : event.key === 'End' ? group.sessions.length - 1 : -1;
                    if (next >= 0) { event.preventDefault(); open(group.sessions[next], { scroll: false }); requestAnimationFrame(() => { const section = Array.from(windowStack.current?.children ?? []).find(element => (element as HTMLElement).dataset.projectId === group.projectId); section?.querySelector<HTMLElement>('.glass-project-terminal:not([hidden]) [role="tab"][aria-selected="true"]')?.focus(); }); }
                  }}>
                    {group.sessions.map(session => <div className="glass-terminal-tab" key={key(session)} data-selected={key(session) === key(group.selected)}>
                      <button role="tab" aria-label={session.sessionName} aria-selected={key(session) === key(group.selected)} tabIndex={key(session) === key(group.selected) ? 0 : -1} onClick={() => open(session, { scroll: false })} title={session.sessionName}>{session.sessionName}</button>
                      <button aria-label={`Close terminal tab ${session.sessionName}`} title="Close tab — tmux keeps running" onClick={event => { event.stopPropagation(); closeWindow(session); }}><X size={12} /></button>
                    </div>)}
                  </div> : undefined}
                  onToggleCollapsed={() => setMinimized(ids => group.collapsed ? ids.filter(id => !group.sessions.some(session => key(session) === id)) : [...new Set([...ids, ...group.sessions.map(key)])])}
                  onClose={() => closeWindow(target)} onTerminated={() => { closeWindow(target); setFocus(items => items.filter(item => key(item) !== key(target))); }} onFocus={() => setActive(target)} onChanged={() => void refresh()} />
              </div>)}
            </motion.section>)}
          </AnimatePresence>
        </div>
      </Panel>
      </Group>
      <nav className="glass-dock glass-surface" aria-label="Focus">
        <button
          className={`glass-home ${!active ? 'selected' : ''}`}
          aria-label="Dolphin chat"
          onClick={focusChat}
        >
          <span className="dolphin-mark">
            <DolphinIcon />
          </span>

        </button>
        <div className="glass-dock-divider" />
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={({ active: dragged, over }) => {
          if (over && dragged.id !== over.id) {
            const ordered = arrayMove(focus, focus.findIndex((t) => key(t) === dragged.id), focus.findIndex((t) => key(t) === over.id));
            setFocus(ordered);
            const rank = (target: Target) => { const index = ordered.findIndex((item) => key(item) === key(target)); return index < 0 ? ordered.length : index; };
            setWindows((items) => [...items].sort((a, b) => rank(a) - rank(b)));
          }
        }}><SortableContext items={focus.map(key)} strategy={horizontalListSortingStrategy}>
        {focus.map((t) => (
          <FocusItem id={key(t)} activity={projects.find((p) => p.id === t.projectId)?.sessions.some((s) => s.name === t.sessionName && s.observation_state !== 'degraded' && s.has_recent_activity) ?? false} selected={windows.some((item) => key(item) === key(t))} key={key(t)} label={`${t.projectName} / ${t.sessionName}`} onOpen={() => open(t)} onUnpin={() => { closeWindow(t); setFocus((xs) => xs.filter((x) => key(x) !== key(t))); }}>
              <Terminal size={19} />
              <span className="glass-dock-copy">
                <span className="glass-dock-project">{t.projectName}</span>
                <span className="glass-dock-session">{t.sessionName}</span>
              </span>
              <span className="glass-dock-status" title={status(projects.find((p) => p.id === t.projectId)?.sessions.find((s) => s.name === t.sessionName) ?? ({ observation_state: 'degraded' } as ControlCenterSession))}>
                <i className="glass-status-dot" />
                <span className="sr-only">{status(projects.find((p) => p.id === t.projectId)?.sessions.find((s) => s.name === t.sessionName) ?? ({ observation_state: 'degraded' } as ControlCenterSession))}</span>
              </span>
          </FocusItem>
        ))}
        </SortableContext></DndContext>
        <button
          className="glass-pin-session"
          aria-label="Pin session"
          onClick={() => setPaletteOpen(true)}
        >
          <Plus size={17} />
          <span>Pin session</span>
        </button>
        {focus.length === 0 && (
          <span className="glass-dock-hint">
            Open a session from your projects to bring it into focus.
          </span>
        )}
      </nav>
    </div></MotionConfig>
  );
}
