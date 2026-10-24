import type { CSSProperties, ReactNode } from 'react';
import { Fragment, Suspense, lazy, useCallback, useEffect, useLayoutEffect, useState, useRef } from 'react';
import { trustedInstallStart } from './agentInstall';
import { AnimatePresence, MotionConfig, motion, useReducedMotion } from 'motion/react';
import { Group, Panel, Separator, usePanelRef } from 'react-resizable-panels';
import GlassSessionWindow from './GlassSessionWindow';
import GlassConversations from './GlassConversations';
import GlassChatTabs, { useChatTabs, useTabState, useTabRef } from './GlassChatTabs';
import AgentSetupPrompt from './AgentSetupPrompt';
import { currentPlatform, isMacPlatform, shortcutLabel } from './shortcutLabel';
import { browserStorage, LAYOUT_KEYS, readChatLayout, readFullscreenProject, readSidebarCollapsed, readSidebarWidth, readWindowHeights, writeLayout } from './workspace/layoutMemory';
import WindowHeightResizer, { defaultWindowHeightLimits } from './workspace/WindowHeightResizer';
import SidebarResizer from './workspace/SidebarResizer';
import { windowKey } from './workspace/windowScope';
import { parseIds, useSharedStorage } from './workspace/sharedStorage';
import { CHAT_MIN_WIDTH, chatFits, clampChatWidth, foldShortcut } from './workspace/chatColumn';
import BrainStatus from './BrainStatus';
import UpdateControl, { canUpdate, type AboutAnchor } from './UpdateControl';
import StatusGlyph from './StatusGlyph';
import { mergeGit } from './gitStatus';
import { glassDocumentTitle } from './documentTitle';
import { forgetTerminalActivity, forgetTerminalActivityUnder, useTerminalActivity } from './terminal/activity';
import { terminalKey } from './terminal/terminalKey';
import { markSeen, seenAt, sessionState, useSeenTurns, type SessionState } from './sessionState';
import MachineSection, { type WorkflowPanelKind } from './MachineSection';
import SidebarProject, { useNow } from './SidebarProject';
import PinnedList from './workspace/PinnedList';
import { GlancePopover, useGlance, type GlanceTarget } from './workspace/HoverGlance';
import { sessionLabel, targetKey, type Target } from './workspace/targets';
import { nextRow, visibleProjects } from './sidebarModel';
import { canConnect, canOpenWindow, machineBridge, terminalReconnectKey, useMachineLinks, type MachineLink } from './machines';
import { ApiContext } from './apiContext';
import { getSetting, useSetting } from './settings';
const ProjectPickerDialog = lazy(() => import('./ProjectPickerDialog'));
const NewSessionDialog = lazy(() => import('./NewSessionDialog'));
const RemoveProjectDialog = lazy(() => import('./RemoveProjectDialog'));
const ConnectMachineDialog = lazy(() => import('./ConnectMachineDialog'));
const DesktopStart = lazy(() => import('./DesktopStart'));
const DownloadsControl = lazy(() => import('./DownloadsControl'));
const SettingsDialog = lazy(() => import('./SettingsDialog'));
const GlassProjectTasks = lazy(() => import('./GlassProjectTasks'));
const DiffPanel = lazy(() => import('./DiffPanel'));
const PortsPanel = lazy(() => import('./PortsPanel'));
const UsagePanel = lazy(() => import('./UsagePanel'));
const HistoryPanel = lazy(() => import('./HistoryPanel'));
const SkillSuggestions = lazy(() => import('./SkillSuggestions'));
import NotificationBell from './NotificationBell';
import {
  ChevronDown,
  Search,
  Plus,
  Sun,
  Moon,
  Terminal,
  X,
  Activity,
  Server,
  ArrowUpRight,
  PanelLeft,
  MessageSquare,
  PanelRightClose,
  FolderClosed,
  Settings as SettingsIcon,
} from 'lucide-react';
import {
  api,
  apiFor,
  pruneClients,
  request,
  DolphinApiError,
  type Api,
  type PendingImport,
} from './api';
import type { SessionChoice } from './NewSessionDialog';
import { resolveTheme } from './theme';
import { chooseTheme, syncThemeSetting } from './workspace/themeChoice';
import { onDesktopCommand, type CommandId } from './desktop/bridge';
import { adjacentTab } from './workspace/tabCycle';
import { runTerminalCommand } from './terminal/commands';
import type {
  ControlCenterProject,
  ControlCenterSession,
  TmuxSession,
  GitStatuses,
  HistoryItem,
  OtherSession,
} from './types';
/** The seen-turns project key for sessions in no project, in the row and in the tab. */
const OTHER_PROJECT_KEY = 'other';
const OtherSessions = lazy(() => import('./OtherSessions'));
const ImportSessionsDialog = lazy(() => import('./ImportSessionsDialog'));
import './glass.css';
import './glassSurfaces.css';
import MarkdownReply, { prefetchMarkdown } from './workspace/MarkdownReply';
import { loadTerminalFeatures, loadTerminalPane, prefetchWhenIdle } from './workspace/prefetch';
import { sameProjects } from './workspace/snapshots';
import CommandPalette from './CommandPalette';
import DolphinIcon from './DolphinIcon';
import { paletteCommands } from './workspace/paletteCommands';
import { isTerminalLikeTarget } from './shortcutTarget';
import { sessionsInViewLabel } from './sessionsInView';
import type { Message, ToolActivity, TrackedWork, Thread } from './workspace/chatTypes';
import ChatComposer, { type ComposerHandle } from './workspace/ChatComposer';
import LiveReply from './workspace/LiveReply';
import Disclosure from './motion/Disclosure';
import { useArrivals } from './motion/useArrivals';
import { arrivalVariants, presence, settleTransition, swapVariants, windowVariants } from './motion/presets';
import { useStable } from './workspace/useStable';
import { trackPanelOpeners } from './useModalPanel';
import { MotionDialogs } from './motion/MotionDialog';

trackPanelOpeners();
type DashboardContext = { open_windows: { project_id: string; session_name: string; minimized: boolean; tab_hidden?: boolean }[]; pinned_sessions: { project_id: string; session_name: string }[]; focused_session: { project_id: string; session_name: string } | null };
type MachineProject = ControlCenterProject & { machine: string };
const key = targetKey;
/** Saved pins: well-formed sessions only, at most 100. */
function parsePins(raw: string | null): Target[] {
  try {
    const saved: unknown = JSON.parse(raw ?? '[]');
    return Array.isArray(saved)
      ? saved.filter((t): t is Target => t && ['projectId', 'projectName', 'sessionName'].every((k) => typeof t[k] === 'string')).slice(0, 100)
      : [];
  } catch {
    return [];
  }
}
/** `desktop`: Dolphin Desktop's build, which has no Missions or legacy views
    but does have System Health. */
/** What fetch says when the backend can't be reached at all (Chromium, Firefox, Safari). */
const NETWORK_ERROR = /Failed to fetch|NetworkError|Load failed/i;

/** The web app's one backend, as a machine, so both builds list projects the same way. */
const LOCAL: MachineLink = {
  id: 'local', kind: 'local', target: null, label: 'This Computer', hostname: null, state: 'connected',
  status: null, error: null, reason: null, offerKey: false, apiBase: null, token: null, epoch: 0,
};

export default function GlassWorkspace({ desktop = false, renderSignals }: {
  desktop?: boolean;
  /** The web app's suggestion tray, shown above the composer. The desktop app has none. */
  renderSignals?: (onDiscuss: (text: string) => void) => ReactNode;
} = {}) {
  const storage = useRef(browserStorage()).current;
  // Dolphin Desktop has no legacy project page, so + opens the folder picker
  // here. It browses the connected machine, which works for SSH hosts too.
  // Each holds the machine (or that machine's project) it was opened for.
  const [pickingProject, setPickingProject] = useState<string | null>(null);
  const [choosingSession, setChoosingSession] = useState<MachineProject | null>(null);
  const [reviewing, setReviewing] = useState<Target | null>(null);
  type WorkflowPanel =
    | { kind: WorkflowPanelKind; machine: string }
    | { kind: 'history'; machine: string; projectId: string; projectName: string };
  const [panel, setPanel] = useState<WorkflowPanel | null>(null);
  const [removingProject, setRemovingProject] = useState<MachineProject | null>(null);
  const [restored] = useState(() => {
    const empty = { windows: [] as Target[], minimized: [] as string[], active: null as Target | null };
    try {
      const saved = JSON.parse(localStorage.getItem(windowKey('dolphin.glass.windows')) ?? 'null');
      if (!saved || !Array.isArray(saved.windows)) return empty;
      const seen = new Set<string>();
      const windows: Target[] = saved.windows.filter((t: Target) => {
        if (!t || !['projectId', 'projectName', 'sessionName'].every(k =>
          typeof t[k as keyof Target] === 'string' && (t[k as keyof Target] as string).trim())) return false;
        if (seen.has(key(t))) return false;
        seen.add(key(t));
        return true;
      }).slice(0, 100);
      return { windows,
        minimized: windows.filter(t => Array.isArray(saved.minimized) && saved.minimized.includes(key(t))).map(key),
        active: windows.find(t => key(t) === saved.active) ?? null };
    } catch { return empty; }
  });

  // Dolphin Desktop: every machine in this window, this computer first. Each
  // one's projects come from its own helper, through its own client.
  const links = useMachineLinks(desktop);
  const sections: MachineLink[] = desktop && links.length ? links : [LOCAL];
  const clientOf = (link: MachineLink | undefined): Api | null => {
    if (!link) return null;
    // This computer failed: its section says so; nothing asks it for projects.
    if (link.id === 'local') return desktop && link.state === 'failed' ? null : api;
    return link.apiBase && link.token !== null && link.state !== 'failed' ? apiFor({ base: link.apiBase, token: link.token }) : null;
  };
  // Each connected machine's client; another machine carries its name. One list
  // for the bell and the agent setup line.
  const machineSources = sections.flatMap((link) => {
    const client = clientOf(link);
    return client ? [{ id: link.id, label: link.id === 'local' ? undefined : link.label, api: client }] : [];
  });
  /** Each machine's Inbox: where the first-run checklist opens its terminals. */
  const inboxOf = (machine: string) => projects.find((project) => project.machine === machine && project.is_inbox);
  const apiOf = (machine: string | undefined) => (machine === 'local' ? api : clientOf(sections.find((link) => link.id === machine)));
  const labelOf = (machine: string | undefined) => sections.find((link) => link.id === machine)?.label ?? '';
  const [projectsBy, setProjectsBy] = useState<Record<string, ControlCenterProject[]>>({});
  const [otherBy, setOtherBy] = useState<Record<string, OtherSession[]>>({});
  const openingOther = useRef(new Set<string>());
  const [, bumpOpening] = useState(0);
  const projects: MachineProject[] = sections.flatMap((link) => (projectsBy[link.id] ?? []).map((project) => ({ ...project, machine: link.id })));
  const machineOfTarget = (target: Target) => target.machine ?? projects.find((project) => project.id === target.projectId)?.machine ?? (desktop ? undefined : 'local');
  // Shared by every Dolphin window (sharedStorage.ts).
  const [collapsedMachines, setCollapsedMachines] = useSharedStorage('dolphin.glass.collapsed-machines', parseIds);
  const [collapsedProjects, setCollapsedProjects] = useSharedStorage('dolphin.glass.collapsed-projects', parseIds);
  // Projects linked in this window stay in view while they have no sessions yet.
  const [revealed, setRevealed] = useState<Set<string>>(() => new Set());
  // Machines whose empty projects the user asked to see.
  const [showEmpty, setShowEmpty] = useState<string[]>([]);
  const now = useNow(30_000);
  // The row to focus once the reveal button has made it exist (the button unmounts on click).
  const [focusProject, setFocusProject] = useState<string | null>(null);
  useEffect(() => {
    if (!focusProject) return;
    document.querySelector<HTMLElement>(`.glass-tree summary[data-project-key="${window.CSS.escape(focusProject)}"]`)?.focus();
    setFocusProject(null);
  }, [focusProject, showEmpty]);
  const [query, setQuery] = useState(''),
    // Pins are shared by every Dolphin window (sharedStorage.ts).
    [focus, setFocus] = useSharedStorage('dolphin.glass.pins', parsePins);
  // Opening used to pin, so the old list (dolphin.glass.focus) holds every
  // session ever opened; pins start empty under their own key.
  useEffect(() => { try { localStorage.removeItem('dolphin.glass.focus'); } catch { /* optional */ } }, []);
  const [active, setActive] = useState<Target | null>(restored.active);
  const [sidebarTab, setSidebarTab] = useState<'projects' | 'tasks'>('projects');
  // The sidebar's panel, and the Tasks panel per project. A panel shown in
  // place of another fades in; the first one appears in place.
  const sidebarPanel = sidebarTab === 'tasks' ? `tasks:${active?.projectId ?? ''}` : 'projects';
  const shownSidebarPanel = useRef<string | null>(null);
  const panelSwap = shownSidebarPanel.current !== null && shownSidebarPanel.current !== sidebarPanel;
  useLayoutEffect(() => { shownSidebarPanel.current = sidebarPanel; });
  const [windows, setWindows] = useState<Target[]>(restored.windows);
  const [minimized, setMinimized] = useState<string[]>(restored.minimized);
  const [projectTabs, setProjectTabs] = useState<Record<string, string>>(() => {
    try { const saved = JSON.parse(localStorage.getItem(windowKey('dolphin.glass.project-tabs')) || '{}');
      return saved && typeof saved === 'object' && !Array.isArray(saved) ? Object.fromEntries(Object.entries(saved).filter(([, value]) => typeof value === 'string')) as Record<string, string> : {};
    } catch { return {}; }
  });
  useEffect(() => { if (active) setProjectTabs(old => ({ ...old, [active.projectId]: active.sessionName })); }, [active]);
  useEffect(() => { try { localStorage.setItem(windowKey('dolphin.glass.project-tabs'), JSON.stringify(projectTabs)); } catch { /* Storage is optional. */ } }, [projectTabs]);
  // A window shows once its machine is connected; until then it waits, saved.
  const shownWindows = windows.filter((target) => apiOf(machineOfTarget(target)));
  const projectWindows = Array.from(new Set(shownWindows.map(target => target.projectId))).map(projectId => {
    const sessions = shownWindows.filter(target => target.projectId === projectId);
    const selected = sessions.find(target => target.sessionName === (active?.projectId === projectId ? active.sessionName : projectTabs[projectId])) || sessions[0];
    return { projectId, sessions, selected, collapsed: sessions.every(target => minimized.includes(key(target))) };
  });
  // Fullscreen belongs to the project window, not to one terminal, so its tab
  // strip stays reachable and switching tabs keeps the window fullscreen.
  const [fullscreenProject, setFullscreenProject] = useState<string | null>(() => readFullscreenProject(storage));
  useEffect(() => writeLayout(storage, LAYOUT_KEYS.fullscreen, fullscreenProject), [storage, fullscreenProject]);
  const fullscreenGroup = projectWindows.find(group => group.projectId === fullscreenProject);
  // Fullscreen puts the projects list and the chat away. Shown again from the
  // top bar, they sit beside the window (glass.css) until fullscreen ends;
  // the remembered layout is never touched, so leaving it restores that.
  const fullscreenOn = fullscreenProject !== null;
  const [fullscreenShows, setFullscreenShows] = useState({ sidebar: false, chat: false });
  useEffect(() => { if (!fullscreenOn) setFullscreenShows({ sidebar: false, chat: false }); }, [fullscreenOn]);
  // Motion measures the window stack only when the window list changes, not on every render.
  const layoutKey = `${projectWindows.map((group) => `${group.projectId}:${group.collapsed}:${group.sessions.length}`).join('|')}|${fullscreenProject ?? ''}`;
  // A remembered fullscreen waits for its window; it is dropped only once the
  // window is known to be gone or minimized.
  useEffect(() => {
    if (!fullscreenProject) return;
    const present = windows.some((target) => target.projectId === fullscreenProject);
    if (!present || (fullscreenGroup && fullscreenGroup.collapsed)) setFullscreenProject(null);
  }, [fullscreenProject, fullscreenGroup, windows]);
  useEffect(() => {
    if (!fullscreenProject) return;
    const exit = (event: KeyboardEvent) => {
      // Escape inside the terminal belongs to the program running there.
      if (event.key !== 'Escape' || event.defaultPrevented || (event.target instanceof Element
        && event.target.closest('.terminal-host, .xterm, input, textarea, select, [contenteditable="true"]'))) return;
      // An open list or menu (the bell's, Downloads) takes this Escape for itself.
      if (document.querySelector('.glass-workspace :is([role="dialog"], [role="menu"])')) return;
      setFullscreenProject(null);
    };
    window.addEventListener('keydown', exit);
    return () => window.removeEventListener('keydown', exit);
  }, [fullscreenProject]);

  useEffect(() => {
    try {
      localStorage.setItem(windowKey('dolphin.glass.windows'), JSON.stringify({ windows, minimized, active: active ? key(active) : null }));
    } catch { /* The workspace remains usable when browser storage is unavailable. */ }
  }, [windows, minimized, active]);
  const windowStack = useRef<HTMLDivElement>(null);
  // Heights set at a stacked window's bottom edge, by project (WindowHeightResizer.tsx).
  const [windowHeights, setWindowHeights] = useState(() => readWindowHeights(storage));
  const commitWindowHeight = useCallback((projectId: string, height: number | null) => {
    setWindowHeights((heights) => {
      const next = { ...heights };
      if (height === null) delete next[projectId];
      else next[projectId] = height;
      writeLayout(storage, LAYOUT_KEYS.windowHeights, next);
      return next;
    });
  }, [storage]);
  const [viewportHeight, setViewportHeight] = useState(() => window.innerHeight);
  useEffect(() => {
    const resize = () => setViewportHeight(window.innerHeight);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  const windowLimits = defaultWindowHeightLimits(viewportHeight);
  const windowOf = (projectId: string) => Array.from(windowStack.current?.children ?? [])
    .find((element) => (element as HTMLElement).dataset.projectId === projectId) as HTMLElement | undefined ?? null;
  const [scrollTarget, setScrollTarget] = useState<{ key: string } | null>(restored.active ? { key: key(restored.active) } : null);
  const reduceMotion = useReducedMotion();
  useEffect(() => {
    const stopPane = prefetchWhenIdle(() => Promise.all([loadTerminalPane(), loadTerminalFeatures()]));
    const stopMarkdown = prefetchWhenIdle(prefetchMarkdown, 3000);
    return () => { stopPane(); stopMarkdown(); };
  }, []);
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
  const hasWindows = shownWindows.some((target) => !minimized.includes(key(target)));
  // Terminal first: windows take the centre, the chat is a column at its right.
  const windowsPanel = usePanelRef();
  const chatPanel = usePanelRef();
  const centre = useRef<HTMLDivElement>(null);
  const savedChat = useRef(readChatLayout(storage)).current;
  const chatWidth = useRef(savedChat.width);
  const [chatFolded, setChatCollapsed] = useState(savedChat.collapsed);
  const chatCollapsed = fullscreenOn ? !fullscreenShows.chat : chatFolded;
  const chatCollapsedRef = useRef(chatCollapsed);
  chatCollapsedRef.current = chatCollapsed;
  // Every person-made change to the chat column is remembered; the narrow-window
  // auto-fold calls setChatCollapsed directly and is not.
  function rememberChat(collapsed: boolean) {
    if (fullscreenOn) { setFullscreenShows((shows) => ({ ...shows, chat: !collapsed })); return; }
    setChatCollapsed(collapsed);
    writeLayout(storage, LAYOUT_KEYS.chat, { width: chatWidth.current, collapsed });
  }
  const mac = isMacPlatform(currentPlatform());
  const hasWindowsRef = useRef(hasWindows);
  hasWindowsRef.current = hasWindows;
  const narrowRef = useRef(narrow);
  narrowRef.current = narrow;
  const windowsShowing = useRef(false);
  useLayoutEffect(() => {
    const windows = windowsPanel.current;
    const chat = chatPanel.current;
    if (!windows || !chat) return;
    if (!hasWindows) {
      windowsShowing.current = false;
      if (chat.isCollapsed()) chat.expand();
      // The windows panel's 30% floor lifts once the group re-registers it
      // (a render later), so the chat takes the whole centre on the next frame.
      const frame = requestAnimationFrame(() => { if (!hasWindowsRef.current) chatPanel.current?.resize('100%'); });
      return () => cancelAnimationFrame(frame);
    }
    // Windows just appeared: in a narrow window the chat steps aside, so the
    // terminal keeps its 80 columns. Show chat brings it back.
    const appeared = !windowsShowing.current;
    windowsShowing.current = true;
    const fold = chatCollapsed || (appeared && !narrow && !chatFits(centre.current?.getBoundingClientRect().width ?? 0, chatWidth.current));
    if (fold && !chatCollapsed) setChatCollapsed(true);
    if (fold) { if (!chat.isCollapsed()) chat.collapse(); return; }
    if (chat.isCollapsed()) chat.expand();
    chat.resize(narrow ? '40%' : `${chatWidth.current}px`);
  }, [hasWindows, chatCollapsed, narrow]);
  function showChat() {
    rememberChat(false);
    focusChat();
  }
  const chatMain = useRef<HTMLElement>(null);
  const showChatButton = useRef<HTMLButtonElement>(null);
  // Folding hides the column that may hold focus; hand it to the terminal in
  // view (the active window's first), or to Show chat, never to <body>.
  function foldChat() {
    if (chatMain.current?.contains(document.activeElement)) {
      const open = '.glass-session-window:not(:has([data-collapsed="true"]))';
      const input = '.glass-project-terminal:not([hidden]) .xterm-helper-textarea';
      const stack = windowStack.current;
      const terminal = stack?.querySelector<HTMLElement>(`${open}[data-active="true"] ${input}`) ?? stack?.querySelector<HTMLElement>(`${open} ${input}`);
      (terminal ?? showChatButton.current)?.focus();
    }
    rememberChat(true);
  }
  const toggleChat = useRef(() => undefined as void);
  toggleChat.current = () => {
    if (!hasWindowsRef.current) return;
    if (chatCollapsedRef.current) rememberChat(false);
    else foldChat();
  };
  function closeWindow(target: Target) {
    // A parked pane keeps its bell; closing the tab is what forgets it.
    forgetTerminalActivity(terminalKey(machineOfTarget(target), target.projectId, target.sessionName));
    setMinimized((ids) => ids.filter((id) => id !== key(target)));
    setWindows((items) => items.filter((item) => key(item) !== key(target)));
    setActive((current) => current && key(current) === key(target) ? null : current);
  }
  function focusChat() {
    // Focusing chat must not close the terminal views described in its context.
    setActive(null);
    rememberChat(false);
    requestAnimationFrame(() => composer.current?.focus());
  }
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsReturn = useRef<HTMLElement | null>(null);
  const paletteTrigger = useRef<HTMLButtonElement>(null);
  const settingsButton = useRef<HTMLButtonElement>(null);
  const openSettings = (from: HTMLElement | null) => { settingsReturn.current = from; setSettingsOpen(true); };
  useEffect(() => syncThemeSetting(), []);
  // Menu commands (spec: "Keyboard"). The ref always holds the current state;
  // this is the one subscription to onDesktopCommand.
  const command = useRef<(id: CommandId) => void>(() => undefined);
  command.current = (id) => {
    // A modal dialog owns the keyboard: nothing acts on the view behind it.
    const modal = document.querySelector<HTMLElement>('[aria-modal="true"]');
    // The palette toggles itself shut; any other modal blocks even that.
    const otherModal = document.querySelector('[aria-modal="true"]:not(.cp-panel)');
    if (modal && !(id === 'palette' && !otherModal)) {
      if (id === 'settings' && settingsOpen) (modal.matches('[role="dialog"]') ? modal : modal.querySelector<HTMLElement>('[role="dialog"]'))?.focus();
      return;
    }
    if (id === 'palette') { setPaletteOpen((value) => !value); return; }
    if (id === 'settings') { openSettings(document.activeElement instanceof HTMLElement ? document.activeElement : null); return; }
    // Find and zoom belong to the terminal area; find needs the session in front.
    if (id === 'zoom-in' || id === 'zoom-out' || id === 'zoom-reset') { runTerminalCommand(id); return; }
    if (id === 'find') { if (active) runTerminalCommand('find', terminalKey(machineOfTarget(active), active.projectId, active.sessionName)); return; }
    if (id === 'close-view') { if (active) closeWindow(active); return; }
    if (id === 'new-session') {
      const project = (active && projects.find((p) => p.id === active.projectId && p.machine === (machineOfTarget(active) ?? p.machine)))
        || projects.find((p) => !p.is_inbox && p.path);
      if (project) void create(project);
      return;
    }
    if (id === 'prev-tab' || id === 'next-tab') {
      const next = adjacentTab(projectWindows.map((group) => group.sessions.map(key)), active ? key(active) : null, id === 'next-tab' ? 1 : -1);
      const target = next ? shownWindows.find((t) => key(t) === next) : undefined;
      if (target) open(target, { scroll: !active || target.projectId !== active.projectId });
      return;
    }
    const pinned = focus[Number(id.slice('session-'.length)) - 1];
    if (pinned) open(pinned);
  };
  useEffect(() => onDesktopCommand((id) => command.current(id)), []);
  const [aboutOpen, setAboutOpen] = useState<AboutAnchor | null>(null);
  const [connecting, setConnecting] = useState(false);
  // Connect to Machine… in the menu opens this window's dialog.
  useEffect(() => (desktop ? machineBridge()?.onConnectOpen?.(() => setConnecting(true)) ?? undefined : undefined), [desktop]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarFolded, setSidebarCollapsed] = useState(() => readSidebarCollapsed(storage));
  useEffect(() => writeLayout(storage, LAYOUT_KEYS.sidebar, sidebarFolded), [storage, sidebarFolded]);
  const sidebarCollapsed = fullscreenOn ? !fullscreenShows.sidebar : sidebarFolded;
  const toggleSidebar = () => {
    if (fullscreenOn) setFullscreenShows((shows) => ({ ...shows, sidebar: !shows.sidebar }));
    else setSidebarCollapsed((value) => !value);
  };
  const [sidebarWidth, setSidebarWidth] = useState(() => readSidebarWidth(storage));
  const workspace = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const host = workspace.current;
    const stack = windowStack.current;
    const edges = ['--glass-fullscreen-left', '--glass-fullscreen-right', '--glass-fullscreen-bottom'];
    if (!host) return;
    if (!fullscreenOn || !stack) { edges.forEach((edge) => host.style.removeProperty(edge)); return; }
    // The window takes the place the window stack has: all of it, less the
    // projects list and the chat when they show.
    const place = () => {
      const rect = stack.getBoundingClientRect();
      const sidebar = !sidebarCollapsed && !window.matchMedia('(max-width: 650px)').matches;
      const chat = !chatCollapsed;
      host.style.setProperty(edges[0], `${sidebar ? Math.round(rect.left) : 0}px`);
      host.style.setProperty(edges[1], `${chat && !narrow ? Math.round(window.innerWidth - rect.right) : 0}px`);
      host.style.setProperty(edges[2], `${chat && narrow ? Math.round(window.innerHeight - rect.bottom) : 0}px`);
    };
    place();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    observer?.observe(stack);
    window.addEventListener('resize', place);
    return () => { observer?.disconnect(); window.removeEventListener('resize', place); };
  }, [fullscreenOn, sidebarCollapsed, chatCollapsed, narrow]);
  const commitSidebarWidth = (width: number) => { setSidebarWidth(width); writeLayout(storage, LAYOUT_KEYS.sidebarWidth, width); };
  const sessionTargets: Target[] = projects.flatMap((p) =>
    p.sessions.map((s) => ({
      projectId: p.id,
      projectName: p.name,
      sessionName: s.name,
      machine: p.machine,
    })),
  );
  useSeenTurns();
  // A session in no project opens under its machine's hidden root project,
  // which `projects` never lists; its state and seen key come from other_sessions.
  const isHidden = (target: Target) => !projects.some((project) => project.machine === machineOfTarget(target) && project.id === target.projectId);
  const sessionOf = (target: Target): ControlCenterSession | undefined => (isHidden(target)
    ? otherBy[machineOfTarget(target) ?? 'local']?.find((session) => session.name === target.sessionName)
    : projects
      .find((project) => project.machine === machineOfTarget(target) && project.id === target.projectId)
      ?.sessions.find((session) => session.name === target.sessionName));
  const seenProjectOf = (target: Target) => (isHidden(target) && sessionOf(target) ? OTHER_PROJECT_KEY : target.projectId);
  /** A target's state; one whose session is not in view yet claims nothing. */
  const stateOfTarget = (target: Target): SessionState => {
    const session = sessionOf(target);
    return session ? sessionState(session, seenAt(machineOfTarget(target) ?? 'local', seenProjectOf(target), target.sessionName)) : 'idle';
  };
  const markTargetSeen = (target: Target) => markSeen(machineOfTarget(target) ?? 'local', seenProjectOf(target), target.sessionName, sessionOf(target)?.turn_at);
  // A system notification's click (Dolphin Desktop): open that session as soon
  // as its machine's projects are here. A request older than a minute is dropped.
  const requestedOpen = useRef<{ target: { machine: string; projectId: string; session: string }; at: number } | null>(null);
  const [openRequests, setOpenRequests] = useState(0);
  useEffect(() => machineBridge()?.onOpenSession?.((target) => {
    requestedOpen.current = { target, at: Date.now() };
    setOpenRequests((value) => value + 1);
  }) ?? undefined, []);
  useEffect(() => {
    const request = requestedOpen.current;
    if (!request) return;
    if (Date.now() - request.at > 60_000) { requestedOpen.current = null; return; }
    if (!(request.target.machine in projectsBy)) return;
    const project = projectsBy[request.target.machine].find((item) => item.id === request.target.projectId);
    requestedOpen.current = null;
    if (!project) { setError('That notification names a project that is no longer here.'); return; }
    open({ projectId: project.id, projectName: project.name, sessionName: request.target.session, machine: request.target.machine });
  }, [openRequests, projectsBy]);
  // The main process raises system notifications; it follows this setting.
  const [systemNotifications] = useSetting('notifications.system');
  useEffect(() => { machineBridge()?.setSystemNotifications?.(systemNotifications); }, [systemNotifications]);
  // Another machine's name goes before its sessions wherever they are listed together.
  const onMachine = (target: Target) => {
    const machine = machineOfTarget(target);
    return desktop && machine && machine !== 'local' ? `${labelOf(machine)} · ` : '';
  };
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      const inTerminal = isTerminalLikeTarget(event.target as HTMLElement);
      const mod = event.metaKey || event.ctrlKey;
      // Ctrl+key inside a terminal belongs to the program (^_ undo, ^K kill-line);
      // on macOS Cmd never reaches it, so Cmd+/ and Cmd+K work there too.
      const fromTerminal = !inTerminal || (isMacPlatform(currentPlatform()) && event.metaKey);
      if (mod && !event.shiftKey && !event.altKey && event.key === '/' && fromTerminal) {
        event.preventDefault();
        toggleChat.current();
        return;
      }
      if (mod && event.key.toLowerCase() === 'k' && fromTerminal) {
        event.preventDefault();
        if (document.querySelector('[aria-modal="true"]:not(.cp-panel)')) return;
        setPaletteOpen((value) => !value);
        return;
      }
      // Cmd/Ctrl+, opens Settings. Dolphin Desktop's menu owns that key
      // (keymap.ts) and the page must leave it alone there.
      if (!desktop && mod && !event.shiftKey && !event.altKey && event.key === ',' && fromTerminal) {
        event.preventDefault();
        if (document.querySelector('[aria-modal="true"]')) return;
        openSettings(document.activeElement instanceof HTMLElement ? document.activeElement : null);
        return;
      }
      if (inTerminal) return;
      if (event.key === 'Escape') setSidebarOpen(false);
    };
    window.addEventListener('keydown', keyboard);
    return () => window.removeEventListener('keydown', keyboard);
  }, [desktop]);
  const activeTitle = useTerminalActivity(active ? terminalKey(machineOfTarget(active), active.projectId, active.sessionName) : null).title;
  useEffect(() => {
    document.title = glassDocumentTitle(active, activeTitle);
  }, [active, activeTitle]);
  // A turn that ends while you are looking at it is seen.
  const activeTurnAt = active ? sessionOf(active)?.turn_at ?? null : null;
  useEffect(() => {
    if (active && activeTurnAt && document.hasFocus()) markTargetSeen(active);
  }, [active ? key(active) : '', activeTurnAt]);
  // Returning to the app after a turn finished clears what you are looking at.
  const markActiveSeen = useRef(() => {});
  markActiveSeen.current = () => { if (active && activeTurnAt) markTargetSeen(active); };
  useEffect(() => {
    const onFocus = () => markActiveSeen.current();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);
  const chatTabs = useChatTabs();
  const tabId = chatTabs.active;
  const retry = useTabRef<{ text: string; thread: string; id: string; dashboard_context: DashboardContext } | null>(
    tabId, null,
  );
  const [pending, setPending, tabPending, setPendingFor] = useTabState(tabId, false);
  const [optimistic, setOptimistic] = useTabState<{ text: string; previousIds: string[] } | null>(tabId, null);
  const [failedMessage, setFailedMessage] = useTabState<string | null>(tabId, null);
  const [themeChoice] = useSetting('theme');
  const theme = resolveTheme(themeChoice, typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches);
  const pinnedKey = (t: Target) => focus.some((f) => key(f) === key(t));
  const palette = paletteCommands({
    desktop, mac, canConnect: canConnect(), canUpdate: canUpdate(), canOpenWindow: canOpenWindow(), theme: themeChoice,
    machines: sections.map((link) => ({ id: link.id, label: link.label, kind: link.kind, state: link.state, target: link.target })),
    projects: projects.map((p) => ({ id: p.id, name: p.name, machine: p.machine, machineLabel: labelOf(p.machine), isInbox: p.is_inbox, sessionCount: p.sessions.length })),
    sessions: sessionTargets.map((t) => ({ id: key(t), label: `${onMachine(t)}${t.projectName} / ${sessionLabel(t.sessionName)}`, pinned: pinnedKey(t) })),
    active: active ? { id: key(active), label: `${active.projectName} / ${sessionLabel(active.sessionName)}`, pinned: pinnedKey(active) } : null,
  });
  const [error, setError] = useTabState(tabId, ''),
    [threads, setThreads] = useState<Thread[]>([]),
    [thread, setThread, tabThreads, setThreadFor] = useTabState(tabId, '', 'dolphin.glass.chat-thread'),
    [messages, setMessages, , setMessagesFor] = useTabState<Message[]>(tabId, []),
    // The thread the tab's messages were loaded for: a thread switch shows the
    // old messages until the new ones arrive, and those arrive as a restore.
    [messagesThread, setMessagesThread, , setMessagesThreadFor] = useTabState(tabId, ''),
    [busy, setBusy, tabBusy] = useTabState(tabId, false),
    [creating, setCreating] = useState(false);
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
      const target = { projectId: work.project_id, projectName: '', sessionName: work.session_name, machine: 'local' };
      closeWindow(target);
      setFocus(items => items.filter(item => key(item) !== key(target)));
      void refresh();
    } catch (error) { setError(String(error)); }
    finally { setClosingWork(''); }
  }
  function renderActivity(items: ToolActivity[]) {
    return <div className="glass-tool-activity" aria-label="Dolphin tool activity">{items.map(item => {
      // The chat runs on this computer, so the projects it names are this computer's.
      const project = projects.find(p => p.machine === 'local' && p.id === item.arguments.project_id);
      const result = item.result as { result?: { name?: string; session_name?: string; engine?: string } } | null;
      const sessionName = result?.result?.name || result?.result?.session_name || item.arguments.session_name;
      const tracked = trackedWork.find(work => work.id === item.id);
      const sessionAction = project && typeof sessionName === 'string' && result?.result
        && ['start_project_work', 'create_session', 'send_work', 'run_native_task'].includes(item.tool);
      return <div key={item.id}>
        {sessionAction && <div className="glass-session-receipt">
          <Terminal size={18} aria-hidden="true" />
          <span><strong>{project.name}</strong><span>{sessionName}</span><small>{tracked?.state === 'closed' ? 'Session closed' : tracked?.finished_at ? 'Agent finished its turn · work not independently verified' : tracked ? 'Tracking agent · no model tokens' : item.status === 'submitted' ? 'Task submitted · completion not yet verified' : item.status === 'unknown' ? 'Inspect session · startup not confirmed' : 'Session ready'}</small></span>
          <button disabled={tracked?.state === 'closed'} aria-label={`Open session ${project.name} / ${sessionName}`} onClick={() => open({ projectId: project.id, projectName: project.name, sessionName, machine: project.machine })}>Open session <ArrowUpRight size={14} /></button>
        </div>}
        <Disclosure bodyClassName="glass-tool-output" summary={<><span>{item.tool.replace(/_/g, ' ')}</span><small data-status={item.status}>{item.status}</small></>}>
        {!sessionAction && project && typeof sessionName === 'string' && <button onClick={() => open({ projectId: project.id, projectName: project.name, sessionName, machine: project.machine })}>Open session</button>}
        <pre>{JSON.stringify(item.result, null, 2)}</pre>
      </Disclosure></div>;
    })}</div>;
  }
  const conversation = useRef<HTMLDivElement>(null);
  const savedScroll = useTabRef(tabId, 0);
  const followTail = useTabRef(tabId, true);
  const composer = useRef<ComposerHandle>(null);
  useLayoutEffect(() => {
    const element = conversation.current;
    if (!element) return;
    // Restore after content is committed but before paint, without CSS smooth
    // scrolling through the history. Readers retain their position in each tab.
    element.scrollTop = followTail.current && (messages.length || busy)
      ? element.scrollHeight : savedScroll.current;
  }, [tabId, messages, busy, optimistic, trackedWork.map(work => `${work.id}:${work.state}`).join('|')]);
  // The live reply grows on its own; it asks the conversation to follow it.
  const followTailRef = useRef(followTail);
  followTailRef.current = followTail;
  const followIfTailing = useCallback(() => {
    const element = conversation.current;
    if (element && followTailRef.current.current) element.scrollTop = element.scrollHeight;
  }, []);
  const [inventoryAvailable, setInventoryAvailable] = useState<boolean | null>(
    null,
  );
  const linksRef = useRef(sections);
  linksRef.current = sections;
  const refreshMachine = (link: MachineLink) => {
    const client = clientOf(link);
    if (!client) return Promise.resolve();
    return client.fetchControlCenter()
      .then((snapshot) => {
        setProjectsBy((current) => (sameProjects(current[link.id], snapshot.projects) ? current : { ...current, [link.id]: snapshot.projects }));
        setOtherBy((current) => ({ ...current, [link.id]: snapshot.other_sessions ?? [] }));
        if (link.id !== 'local') return;
        setInventoryAvailable(true);
        // The backend answers again: a banner that only said it couldn't be reached is stale.
        setError((current) => (NETWORK_ERROR.test(current) ? '' : current));
      })
      .catch((e) => {
        // Another machine's link has its own state in its section; this
        // computer's backend failing is the workspace's problem.
        if (link.id !== 'local') return;
        setInventoryAvailable(false);
        setError(String(e));
      });
  };
  const refresh = () => Promise.all(linksRef.current.map(refreshMachine)).then(() => undefined);
  // One refresh at a time per machine; a turn event during one runs one more after it.
  const refreshing = useRef(new Map<string, 'running' | 'again'>());
  const refreshSoon = (machine: string) => {
    const link = linksRef.current.find((item) => item.id === machine);
    if (!link) return;
    if (refreshing.current.has(machine)) { refreshing.current.set(machine, 'again'); return; }
    refreshing.current.set(machine, 'running');
    void refreshMachine(link).finally(() => {
      const again = refreshing.current.get(machine) === 'again';
      refreshing.current.delete(machine);
      if (again) refreshSoon(machine);
    });
  };
  // Dolphin Desktop: the folders of tmux sessions already running on a
  // machine become projects (once each), so their sessions show up too.
  const [importAsk, setImportAsk] = useState<{ machine: string; label: string; pending: PendingImport[] } | null>(null);
  // Asked at most once per machine per launch; "Not now" waits for the next launch.
  const importAsked = useRef(new Set<string>());
  // Machines whose Agent setup line is unanswered; null until it has reported.
  const [setupHolding, setSetupHolding] = useState<string[] | null>(null);
  const importSessions = (link: MachineLink) => clientOf(link)?.importTmuxProjects()
    .then((result) => {
      if (result.added.length) void refreshMachine(link);
      if (result.pending.length && !importAsked.current.has(link.id)) {
        importAsked.current.add(link.id);
        setImportAsk({ machine: link.id, label: link.label, pending: result.pending });
      }
    })
    .catch(() => undefined);
  // Rejects when the answer could not be sent, so the dialog stays and says why.
  const answerImport = async (paths: string[] | null) => {
    const ask = importAsk;
    if (!ask) return;
    if (paths === null) { setImportAsk(null); return; }
    const link = sections.find((item) => item.id === ask.machine);
    const client = link && clientOf(link);
    if (!client || !link) { setImportAsk(null); return; }
    await client.importTmuxProjects(paths, ask.pending.map((item) => item.path));
    setImportAsk(null);
    void refreshMachine(link);
  };
  useEffect(() => {
    let tick = 0;
    const timer = setInterval(() => {
      void refresh();
      if (desktop && ++tick % 4 === 0) linksRef.current.forEach((link) => void importSessions(link));
    }, 15000);
    return () => clearInterval(timer);
  }, []);
  // A machine just added comes into view in the projects list.
  const seenMachines = useRef(new Set(sections.map((link) => link.id)));
  const machineIds = sections.map((link) => link.id).join('|');
  useEffect(() => {
    const added = sections.find((link) => !seenMachines.current.has(link.id));
    sections.forEach((link) => seenMachines.current.add(link.id));
    if (!added) return;
    setSidebarTab('projects');
    setCollapsedMachines((ids) => ids.filter((id) => id !== added.id));
    requestAnimationFrame(() => document.querySelector(`[data-machine="${window.CSS.escape(added.id)}"]`)
      ?.scrollIntoView({ block: 'start', behavior: reduceMotion ? 'instant' : 'smooth' }));
  }, [machineIds]);
  // A machine that connects, comes back, or gets a new token loads at once.
  const loaded = useRef(new Set<string>());
  const linkKeys = sections.map((link) => `${link.id} ${link.state} ${link.apiBase} ${link.token}`).join('|');
  useEffect(() => {
    for (const link of sections) {
      const id = `${link.id} ${link.state} ${link.apiBase} ${link.token}`;
      if (link.state !== 'connected' || loaded.current.has(id)) continue;
      loaded.current.add(id);
      void refreshMachine(link);
      if (desktop) void importSessions(link);
    }
  }, [linkKeys]);
  // Git state (workflow): one request per machine every 30 s, only for machines
  // that are connected and either expanded in the list or showing a window, and
  // never while the window is hidden. Unchanged statuses keep their identity so
  // the memoised session windows do not re-render.
  const [gitBy, setGitBy] = useState<Record<string, GitStatuses>>({});
  const gitWantedRef = useRef<(link: MachineLink) => boolean>(() => true);
  gitWantedRef.current = (link) => link.state === 'connected'
    && (!collapsedMachines.includes(link.id) || windows.some((target) => machineOfTarget(target) === link.id));
  const refreshGit = (link: MachineLink) => clientOf(link)?.fetchGitStatus()
    .then((statuses) => setGitBy((current) => ({ ...current, [link.id]: mergeGit(current[link.id], statuses) })))
    .catch(() => undefined);
  const refreshGitOf = (machine: string) => { const link = linksRef.current.find((item) => item.id === machine); if (link) void refreshGit(link); };
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === 'hidden') return;
      linksRef.current.filter((link) => gitWantedRef.current(link)).forEach((link) => void refreshGit(link));
    };
    tick();
    const timer = setInterval(tick, 30000);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', tick); };
  }, [linkKeys]);
  // Clients for addresses and tokens no machine has any more are dropped.
  useEffect(() => {
    if (!desktop) return;
    pruneClients(sections.flatMap((link) => (link.id !== 'local' && link.apiBase && link.token !== null ? [{ base: link.apiBase, token: link.token }] : [])));
  }, [linkKeys]);
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
      setMessagesThread('');
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
          setMessagesThread(thread);
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
          setMessagesThreadFor(tab.id, id);
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
    setSidebarOpen(false);
    setError('');
    setActive(t);
    markTargetSeen(t);
    if (scroll) setScrollTarget({ key: key(t) });
    setMinimized(ids => ids.filter(id => !windows.some(item => item.projectId === t.projectId && key(item) === id) && id !== key(t)));
    setWindows((old) => old.some((item) => key(item) === key(t)) ? old : [...old, t]);
  }
  function togglePin(t: Target) {
    setFocus((old) => (old.some((item) => key(item) === key(t)) ? old.filter((item) => key(item) !== key(t)) : [...old, t]));
  }
  // The window map hands these to every window; each takes its target.
  const selectTab = (t: Target) => open(t, { scroll: false });
  const toggleFullscreen = (projectId: string) => setFullscreenProject((current) => (current === projectId ? null : projectId));
  const newSessionIn = (projectId: string, ask = false) => { const project = projects.find((item) => item.id === projectId); if (project) void create(project, undefined, { ask }); };
  const toggleCollapsed = (projectId: string) => {
    const group = projectWindows.find((item) => item.projectId === projectId);
    if (!group) return;
    setMinimized((ids) => (group.collapsed ? ids.filter((id) => !group.sessions.some((s) => key(s) === id)) : [...new Set([...ids, ...group.sessions.map(key)])]));
  };
  const terminated = (t: Target) => { closeWindow(t); setFocus((items) => items.filter((item) => key(item) !== key(t))); };
  // A session counts as seen when its terminal is focused (status area).
  const focusTarget = (t: Target) => { setActive(t); markTargetSeen(t); };
  const refreshAll = () => void refresh();
  // Stable identities, so a memoised window renders only when its own props change.
  const selectTabStable = useStable(selectTab);
  const closeWindowStable = useStable(closeWindow);
  const toggleFullscreenStable = useStable(toggleFullscreen);
  const newSessionInStable = useStable(newSessionIn);
  const toggleCollapsedStable = useStable(toggleCollapsed);
  const togglePinStable = useStable(togglePin);
  const reviewStable = useStable((target: Target) => setReviewing(target));
  const terminatedStable = useStable(terminated);
  const focusTargetStable = useStable(focusTarget);
  const refreshAllStable = useStable(refreshAll);
  // The server decides whether a worktree may be archived and says why not in
  // plain words; a refusal leaves the session and its folder exactly as they were.
  async function archive(project: MachineProject, session: ControlCenterSession) {
    const client = apiOf(project.machine);
    if (!client) return;
    try {
      await client.archiveWorktree(project.id, session.name);
      terminated({ projectId: project.id, projectName: project.name, sessionName: session.name, machine: project.machine });
      await refresh();
      refreshGitOf(project.machine);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }
  const archiveStable = useStable(archive);
  // A session in no project opens through the machine's hidden root project. A
  // double-click opens once; a refusal shows in the workspace's error line.
  async function openOther(link: MachineLink, session: OtherSession) {
    const client = clientOf(link);
    const id = `${link.id} ${session.name}`;
    if (!client || openingOther.current.has(id)) return;
    openingOther.current.add(id); bumpOpening((n) => n + 1);
    try {
      const found = await client.openOtherSession(session.name);
      open({ projectId: found.project_id, projectName: found.project_name, sessionName: session.name, machine: link.id });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      openingOther.current.delete(id); bumpOpening((n) => n + 1);
    }
  }
  const glance = useGlance();
  const creatingNow = useRef(new Set<string>());
  async function create(project: MachineProject, choice?: SessionChoice, { ask = false }: { ask?: boolean } = {}) {
    // Dolphin Desktop starts the default from Settings, or asks what to run:
    // an agent, an install, a tmux session or a plain terminal.
    if (desktop && !choice) {
      const preferred = getSetting('newSession.defaultAgent');
      if (ask || preferred === 'ask') { setChoosingSession(project); return; }
      choice = { mode: preferred };
    }
    const client = apiOf(project.machine);
    if (!client) return;
    // A second call for the same project and choice while one is under way (a double click) is the same click.
    const inFlight = `${project.machine} ${project.id} ${choice?.mode ?? 'shell'} ${choice?.startup ?? ''} ${choice?.worktree?.branch ?? ''}`;
    if (creatingNow.current.has(inFlight)) return;
    creatingNow.current.add(inFlight);
    setCreating(true);
    setError('');
    try {
      let s: TmuxSession;
      let warning: string | null = null;
      if (choice?.worktree) {
        const launched = await client.launchSession(project.id, {
          mode: choice.mode,
          worktree: { branch: choice.worktree.branch, run_setup: choice.worktree.runSetup },
        });
        s = launched.session;
        warning = launched.warning;
      } else {
        s = await client.createTmuxSession(project.id, undefined, choice?.mode ?? 'shell');
        warning = s.warning ?? null;  // the agent asked for is missing; the other one started
        if (choice?.startup) await client.sendTmuxInput(project.id, s.name, choice.startup);
      }
      await refresh();
      refreshGitOf(project.machine);
      open({
        projectId: project.id,
        projectName: project.name,
        sessionName: s.name,
        machine: project.machine,
      });
      if (warning) setError(warning);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      creatingNow.current.delete(inFlight);
      setCreating(false);
    }
  }
  async function send(text: string) {
    if (!text || busy || pending) return;
    const sentFrom = tabId;
    setFailedMessage(null);
    setOptimistic({ text, previousIds: messages.map((message) => message.id) });
    followTail.current = true;
    setBusy(true);
    setError('');
    const identity = (target: Target) => ({ project_id: target.projectId, session_name: target.sessionName });
    // The chat runs on this computer and knows only its projects.
    const here = (target: Target) => machineOfTarget(target) === 'local';
    const dashboard_context: DashboardContext = {
      open_windows: windows.filter(here).map((target) => ({ ...identity(target), minimized: minimized.includes(key(target)), ...(projectWindows.find(group => group.projectId === target.projectId)?.selected.sessionName !== target.sessionName ? { tab_hidden: true } : {}) })),
      pinned_sessions: focus.filter(here).map(identity),
      focused_session: active && here(active) ? identity(active) : null,
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
      setMessagesThread(id);
      retry.current = null;
      void refresh();
      if (result.status === 'in_progress') setPending(true);
      if (result.status !== 'completed' && result.status !== 'in_progress') {
        composer.current?.restore(text, sentFrom);
        setFailedMessage(text);
        setError(`Response ${result.status}. ${result.display_text}`);
      }
    } catch (e) {
      composer.current?.restore(text, sentFrom);
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
  // Only messages sent or received while this conversation is on screen rise
  // in; restored history, tab and thread switches show in place. The sent
  // message takes over from its optimistic copy, and a reply from the text
  // that streamed for it, without rising a second time.
  const [streaming, setStreaming] = useState(false);
  const arrived = useArrivals(`${tabId}:${messagesThread}`, [
    ...visibleMessages.map((message) => ({ id: message.id, standIn: message.role === 'user' ? `user:${message.text}` : 'reply' })),
    ...(streaming && visibleMessages[visibleMessages.length - 1]?.role !== 'assistant' ? [{ id: 'streaming', standIn: 'reply' }] : []),
  ]);
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
                  const project = projects.find(item => item.machine === 'local' && item.id === work.project_id);
                  return <div className="glass-session-receipt glass-work-update" key={work.id}>
                    <Terminal size={18} aria-hidden="true" />
                    <span><strong>{work.state === 'closed' ? 'Session closed' : work.finished_at ? 'Agent finished its turn' : 'Session unavailable'}</strong>
                      <span>{project?.name || 'Project'} / {work.session_name}</span>
                      <small>{work.summary_status === 'running' ? 'Preparing a short summary…' : work.summary_status === 'failed' || work.summary_status === 'unknown' ? 'Summary unavailable. Open the session to review its result.' : work.summary_status === 'completed' ? 'Summary added to this conversation.' : work.state === 'closed' ? 'Completion record kept.' : work.state === 'working' ? 'New work is running in this session.' : work.state === 'unavailable' ? 'No live session found. Completion cannot be verified.' : 'Review the result in the terminal. Work is not independently verified.'}</small>
                    </span>
                    {work.state !== 'closed' && work.state !== 'unavailable' && <>
                      <button onClick={() => open({ projectId: work.project_id, projectName: project?.name || 'Project', sessionName: work.session_name, machine: 'local' })}>Open session <ArrowUpRight size={14} /></button>
                      <button disabled={work.state !== 'stopped' || !!closingWork || trackingError} title="Terminate this completed agent session. Leave it open by taking no action." onClick={() => void closeTrackedWork(work)}>{closingWork === work.id ? 'Closing…' : 'Close session'}</button>
                    </>}
                  </div>;
                })}
              </div>
    );
  }
  const count = projects.reduce((n, p) => n + p.sessions.length, 0);
  const matches = (p: MachineProject) => `${p.name} ${p.sessions.map((s) => s.name).join(' ')}`
    .toLowerCase()
    .includes(query.toLowerCase());
  function linkProject(machine: string, path: string, name = path.replace(/\/+$/, '').split('/').pop() || path) {
    const client = apiOf(machine);
    if (!client) return Promise.resolve();
    return client.createProject({ name, path })
      .then((project) => {
        setRevealed((old) => new Set(old).add(`${machine} ${project.id}`));
        return refresh();
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  }
  // The glance reads the session's own machine, never the local backend; a session already on screen needs none.
  const glanceTarget = (t: Target): GlanceTarget | null => {
    const client = apiOf(machineOfTarget(t));
    const onScreen = projectWindows.some((group) => !group.collapsed && key(group.selected) === key(t));
    return client && !onScreen ? { key: key(t), label: `${onMachine(t)}${t.projectName} / ${sessionLabel(t.sessionName)}`, projectId: t.projectId, sessionName: t.sessionName, api: client } : null;
  };
  // One launch per transcript at a time: a second click before the first
  // resolves must not start a second session.
  const resuming = useRef(new Set<string>());
  async function resume(machine: string, projectId: string, projectName: string, item: HistoryItem) {
    const client = apiOf(machine);
    const guard = `${machine} ${projectId} ${item.agent}:${item.id}`;
    if (!client || resuming.current.has(guard)) return;
    resuming.current.add(guard);
    setPanel(null);
    setError('');
    try {
      const launched = await client.launchSession(projectId, { mode: item.agent, resume: { agent: item.agent, id: item.id } });
      await refresh();
      open({ projectId, projectName, sessionName: launched.session.name, machine });
      if (launched.warning) setError(launched.warning);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      resuming.current.delete(guard);
    }
  }
  function renderProject(p: MachineProject) {
    const id = `${p.machine} ${p.id}`;
    return (
      <SidebarProject
        key={id}
        project={p}
        machine={p.machine}
        machineLabel={desktop && sections.length > 1 ? labelOf(p.machine) : undefined}
        collapsed={collapsedProjects.includes(id)}
        selectedSession={active && active.projectId === p.id && machineOfTarget(active) === p.machine ? active.sessionName : null}
        stateOf={(s) => sessionState(s, seenAt(p.machine, p.id, s.name))}
        now={now}
        creating={creating}
        onToggle={(next) => setCollapsedProjects((ids) => (next ? [...new Set([...ids, id])] : ids.filter((item) => item !== id)))}
        onOpen={(s) => open({ projectId: p.id, projectName: p.name, sessionName: s.name, machine: p.machine })}
        pinned={(name) => focus.some((f) => f.projectId === p.id && f.sessionName === name)}
        onTogglePin={(s) => togglePin({ projectId: p.id, projectName: p.name, sessionName: s.name, machine: p.machine })}
        rowProps={(s) => glance.bind(glanceTarget({ projectId: p.id, projectName: p.name, sessionName: s.name, machine: p.machine }))}
        onNewSession={(ask) => void create(p, undefined, { ask })}
        onRemove={p.is_inbox ? undefined : () => setRemovingProject(p)}
        git={gitBy[p.machine]?.projects?.[p.id]}
        worktreeOf={(name) => gitBy[p.machine]?.sessions?.[name]}
        onArchive={(s) => void archiveStable(p, s)}
        onHistory={desktop ? () => setPanel({ kind: 'history', machine: p.machine, projectId: p.id, projectName: p.name }) : undefined}
      />
    );
  }
  return (
    <MotionConfig reducedMotion="user"><MotionDialogs><div ref={workspace} className="glass-workspace" data-sidebar-open={sidebarOpen} data-sidebar-collapsed={sidebarCollapsed} style={{ '--glass-sidebar-user-width': `${sidebarWidth}px` } as CSSProperties}>
      <CommandPalette
        items={palette.items}
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onSelect={(item) => {
          const command = palette.commands.get(item.id);
          if (!command) return;
          switch (command.kind) {
            case 'chat': focusChat(); break;
            case 'settings': openSettings(paletteTrigger.current); break;
            case 'connect': setConnecting(true); break;
            case 'new-window': machineBridge()?.newWindow?.(); break;
            case 'updates':
              setAboutOpen('brand');
              void (window as { dolphinDesktop?: { checkUpdates?: () => Promise<unknown> } }).dolphinDesktop?.checkUpdates?.();
              break;
            case 'theme': chooseTheme(command.theme); break;
            case 'add-project': setPickingProject(command.machine); break;
            case 'health': window.location.hash = command.machine === 'local' ? '#/health' : `#/health/${encodeURIComponent(command.machine)}`; break;
            case 'disconnect': if (command.target !== 'local') { machineBridge()?.closeMachine?.(command.target); forgetTerminalActivityUnder(`${command.target}|`); } break;
            case 'pin': {
              const t = sessionTargets.find((s) => key(s) === command.sessionId) ?? (active && key(active) === command.sessionId ? active : undefined);
              if (t) togglePin(t);
              break;
            }
            case 'project': {
              const project = projects.find((p) => p.id === command.projectId && p.machine === command.machine);
              if (!project) break;
              const last = project.sessions.find((s) => s.name === projectTabs[project.id]) ?? project.sessions[0];
              if (last) open({ projectId: project.id, projectName: project.name, sessionName: last.name, machine: project.machine });
              else void create(project);
              break;
            }
            case 'session': { const t = sessionTargets.find((s) => key(s) === command.sessionId); if (t) open(t); break; }
          }
        }}
      />
      {/* Each dialog sits in its own AnimatePresence so it can animate out
          (motion/MotionDialog.tsx); the key is what it is open for. */}
      <AnimatePresence>
      {pickingProject && apiOf(pickingProject) && (
        <Suspense key={`picker:${pickingProject}`} fallback={null}>
          <ApiContext.Provider value={apiOf(pickingProject) ?? api}>
            <ProjectPickerDialog
              machine={desktop ? (pickingProject === 'local' ? 'this computer' : labelOf(pickingProject)) : undefined}
              onClose={() => setPickingProject(null)}
              onPick={(path) => {
                const machine = pickingProject;
                setPickingProject(null);
                linkProject(machine, path);
              }}
            />
          </ApiContext.Provider>
        </Suspense>
      )}
      </AnimatePresence>
      <AnimatePresence>
      {connecting && (
        <Suspense key="connect" fallback={null}>
          <ConnectMachineDialog onClose={() => setConnecting(false)} currentTarget={null} />
        </Suspense>
      )}
      </AnimatePresence>
      <AnimatePresence>
      {removingProject && (
        <Suspense key={`remove:${removingProject.machine ?? 'local'}:${removingProject.id}`} fallback={null}>
          <ApiContext.Provider value={apiOf(removingProject.machine) ?? api}>
          <RemoveProjectDialog
            project={removingProject}
            onClose={() => setRemovingProject(null)}
            onRemoved={() => {
              const removed = removingProject.id;
              setRemovingProject(null);
              // Its windows and dock shortcuts go with it; the tmux sessions stay.
              for (const item of windows) if (item.projectId === removed) forgetTerminalActivity(terminalKey(machineOfTarget(item), item.projectId, item.sessionName));
              forgetTerminalActivityUnder(`${removingProject.machine ?? 'local'}|${removed}|`);
              setWindows((items) => items.filter((item) => item.projectId !== removed));
              setFocus((items) => items.filter((item) => item.projectId !== removed));
              setMinimized((ids) => ids.filter((id) => (JSON.parse(id) as string[])[0] !== removed));
              void refresh();
            }}
          />
          </ApiContext.Provider>
        </Suspense>
      )}
      </AnimatePresence>
      <AnimatePresence>
      {panel && apiOf(panel.machine) && (
        <Suspense key={`panel:${JSON.stringify(panel)}`} fallback={null}>
          <ApiContext.Provider value={apiOf(panel.machine) ?? api}>
            {panel.kind === 'ports' && (
              <PortsPanel machineId={panel.machine} machineLabel={labelOf(panel.machine)} remote={panel.machine !== 'local'} onClose={() => setPanel(null)} />
            )}
            {panel.kind === 'usage' && <UsagePanel machineLabel={labelOf(panel.machine)} onClose={() => setPanel(null)} />}
            {panel.kind === 'history' && (
              <HistoryPanel projectId={panel.projectId} projectName={panel.projectName} onClose={() => setPanel(null)}
                onResume={(item) => void resume(panel.machine, panel.projectId, panel.projectName, item)} />
            )}
          </ApiContext.Provider>
        </Suspense>
      )}
      </AnimatePresence>
      <AnimatePresence>
      {reviewing && apiOf(machineOfTarget(reviewing)) && (
        <Suspense key={`review:${key(reviewing)}`} fallback={null}>
          <ApiContext.Provider value={apiOf(machineOfTarget(reviewing)) ?? api}>
            <DiffPanel projectId={reviewing.projectId} sessionName={reviewing.sessionName}
              hasAgent={Boolean(sessionOf(reviewing)?.agent ?? sessionOf(reviewing)?.is_codex_running)} onClose={() => setReviewing(null)} />
          </ApiContext.Provider>
        </Suspense>
      )}
      </AnimatePresence>
      <AnimatePresence>
      {choosingSession && (
        <Suspense key={`new-session:${choosingSession.machine ?? 'local'}:${choosingSession.id}`} fallback={null}>
          <ApiContext.Provider value={apiOf(choosingSession.machine) ?? api}>
          <NewSessionDialog
            projectId={choosingSession.id}
            projectName={choosingSession.name}
            onClose={() => setChoosingSession(null)}
            onChoose={(choice) => {
              const project = choosingSession;
              setChoosingSession(null);
              void create(project, choice);
            }}
          />
          </ApiContext.Provider>
        </Suspense>
      )}
      </AnimatePresence>
      <AnimatePresence>
      {settingsOpen && (
        <Suspense key="settings" fallback={null}>
          <SettingsDialog returnFocus={settingsReturn.current} onClose={() => setSettingsOpen(false)} machines={desktop ? sections : []} onConnect={desktop && canConnect() ? () => setConnecting(true) : undefined} />
        </Suspense>
      )}
      </AnimatePresence>
      {/* Held back while the machine's Agent setup line needs a click: a modal over it blocks the button. */}
      <AnimatePresence>
      {importAsk && setupHolding && !setupHolding.includes(importAsk.machine) && (
        <Suspense key={`import:${importAsk.machine}`} fallback={null}>
          <ImportSessionsDialog machineLabel={importAsk.label} pending={importAsk.pending} onAnswer={answerImport} />
        </Suspense>
      )}
      </AnimatePresence>
      <header className="glass-top">
        <button className="glass-desktop-sidebar-toggle" aria-label={sidebarCollapsed ? 'Expand projects' : 'Collapse projects'} aria-expanded={!sidebarCollapsed} aria-controls="glass-projects" onClick={toggleSidebar}><PanelLeft size={18} /></button>
        <button
          className="glass-sidebar-toggle"
          aria-label="Toggle projects"
          aria-expanded={sidebarOpen}
          aria-controls="glass-projects"
          onClick={() => setSidebarOpen((value) => !value)}
        >
          <PanelLeft size={19} />
        </button>
        {desktop && canUpdate() ? (
          <button
            type="button"
            className="glass-brand glass-brand-button"
            aria-label="About Dolphin"
            aria-haspopup="dialog"
            aria-expanded={aboutOpen === 'brand'}
            onClick={(event) => { event.stopPropagation(); setAboutOpen((value) => (value ? null : 'brand')); }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <span className="dolphin-mark">
              <DolphinIcon />
            </span>
          </button>
        ) : (
          <a className="glass-brand" href="#/workspace" aria-label="Dolphin">
            <span className="dolphin-mark">
              <DolphinIcon />
            </span>
          </a>
        )}
        {!desktop && <a className="glass-fleet-link" href="#/fleet">Missions</a>}
        <button
          ref={paletteTrigger}
          className="glass-global-search"
          onClick={() => setPaletteOpen(true)}
          aria-label="Open command palette"
        >
          <Search size={15} />
          <span>Search projects, sessions, or jump to…</span>
          <kbd>{shortcutLabel('K')}</kbd>
        </button>
        <span className="glass-connected">
          {inventoryAvailable && <i />}
          {inventoryAvailable
            ? sessionsInViewLabel(count)
            : inventoryAvailable === false
              ? 'Backend unavailable'
              : 'Connecting…'}
        </span>
        {desktop && <UpdateControl open={aboutOpen} onOpenChange={setAboutOpen} />}
        <button
          ref={showChatButton}
          className="glass-chat-toggle"
          aria-label="Show chat"
          data-chat-folded={hasWindows && chatCollapsed}
          title={`Dolphin chat (${foldShortcut(mac)})`}
          onClick={showChat}
        >
          <MessageSquare size={17} aria-hidden="true" />
        </button>
        {desktop && <Suspense fallback={null}><DownloadsControl /></Suspense>}
        <NotificationBell onOpen={open} onTurn={refreshSoon} sources={desktop ? machineSources : undefined} />
        <button
          aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
          onClick={() => chooseTheme(theme === 'light' ? 'dark' : 'light')}
        >
          {theme === 'light' ? <Moon size={18} /> : <Sun size={18} />}
        </button>
        <button
          ref={settingsButton}
          className="glass-settings-button"
          aria-label="Settings"
          aria-haspopup="dialog"
          aria-expanded={settingsOpen}
          title={`Settings (${mac ? '⌘,' : 'Ctrl+,'})`}
          onClick={() => openSettings(settingsButton.current)}
        >
          <SettingsIcon size={18} aria-hidden="true" />
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
          <button role="tab" id="glass-projects-tab" tabIndex={sidebarTab === 'projects' ? 0 : -1} aria-selected={sidebarTab === 'projects'} aria-controls="glass-projects-panel" title={`${projects.length} ${projects.length === 1 ? 'project' : 'projects'}`} onClick={() => setSidebarTab('projects')}><span>Projects</span><span className="glass-tab-count" aria-hidden="true">{projects.length}</span></button>
          <button role="tab" id="glass-tasks-tab" tabIndex={sidebarTab === 'tasks' ? 0 : -1} aria-selected={sidebarTab === 'tasks'} aria-controls="glass-tasks-panel" onClick={() => setSidebarTab('tasks')}>Tasks</button>
          <button
            className="glass-close-projects"
            aria-label="Close projects"
            onClick={() => setSidebarOpen(false)}
          >
            <X size={15} />
          </button>
          {!desktop && (
            <a href="#/" aria-label="Manage projects">
              <Plus size={15} />
            </a>
          )}
        </div>
        {sidebarTab === 'tasks' ? <motion.div key={sidebarPanel} id="glass-tasks-panel" role="tabpanel" aria-labelledby="glass-tasks-tab" className="glass-sidebar-panel" variants={swapVariants} initial={panelSwap ? "hidden" : false} animate="shown">
          {active && apiOf(machineOfTarget(active)) ? <ApiContext.Provider value={apiOf(machineOfTarget(active)) ?? api}><Suspense fallback={null}><GlassProjectTasks
            key={active.projectId}
            projectId={active.projectId}
            projectName={active.projectName}
            sessionName={active.sessionName}
            machine={machineOfTarget(active) ?? 'local'}
            sessions={projects.find((project) => project.id === active.projectId && project.machine === (machineOfTarget(active) ?? 'local'))?.sessions ?? []}
            onOpenSession={(name) => {
              const target = { projectId: active.projectId, projectName: active.projectName, sessionName: name, machine: machineOfTarget(active) };
              void refresh().then(() => open(target));
            }}
          /></Suspense></ApiContext.Provider> : <p className="glass-task-empty">Select an open terminal window to see its project’s tasks.</p>}
        </motion.div> : <motion.div key="projects" id="glass-projects-panel" role="tabpanel" aria-labelledby="glass-projects-tab" className="glass-sidebar-panel" variants={swapVariants} initial={panelSwap ? "hidden" : false} animate="shown">
        <label className="glass-project-filter">
          <Search size={14} />
          <input
            aria-label="Filter projects and sessions"
            placeholder="Filter projects…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <div className="glass-tree" onKeyDown={(event) => {
          // j/k move between rows only while a row has focus; anywhere else they are letters.
          if (event.altKey || event.ctrlKey || event.metaKey || (event.key !== 'j' && event.key !== 'k')) return;
          const target = event.target as HTMLElement;
          if (!target.matches('[data-nav-row]')) return;
          const rows = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-nav-row]')].filter((item) => item.getClientRects().length > 0);
          const index = nextRow(rows.length, rows.indexOf(target), event.key === 'j' ? 1 : -1);
          if (index < 0) return;
          event.preventDefault();
          rows[index].focus();
        }}>
          <PinnedList
            glance={(id) => { const t = focus.find((item) => key(item) === id); return t ? glance.bind(glanceTarget(t)) : {}; }}
            items={focus.map((t, index) => ({
              id: key(t),
              label: `${onMachine(t)}${t.projectName} / ${sessionLabel(t.sessionName)}`,
              project: `${onMachine(t)}${t.projectName}`,
              session: t.sessionName,
              selected: !!active && key(active) === key(t),
              glyph: <StatusGlyph state={stateOfTarget(t)} />,
              shortcut: desktop && index < 9 ? `${mac ? '⌘' : 'Ctrl+'}${index + 1}` : null,
              activityKey: terminalKey(machineOfTarget(t), t.projectId, t.sessionName),
            }))}
            onOpen={(id) => { const t = focus.find((item) => key(item) === id); if (t) open(t); }}
            onUnpin={(id) => setFocus((items) => items.filter((item) => key(item) !== id))}
            onReorder={(ids) => {
              const ordered = ids.map((id) => focus.find((item) => key(item) === id)).filter((t): t is Target => !!t);
              setFocus(ordered);
              const rank = (target: Target) => { const index = ordered.findIndex((item) => key(item) === key(target)); return index < 0 ? ordered.length : index; };
              setWindows((items) => [...items].sort((a, b) => rank(a) - rank(b)));
            }}
          />
          {inventoryAvailable === false && (
            <div className="glass-inventory-error">
              <p>Session inventory unavailable.</p>
              <button onClick={() => void refresh()}>Retry connection</button>
            </div>
          )}
          {inventoryAvailable && projects.length > 0 && query && !projects.some(matches) && (
            <p className="glass-inventory-error">
              No sessions or projects match “{query}”.
            </p>
          )}
          {sections.map((link) => {
            const own = projects.filter((p) => p.machine === link.id);
            const revealedHere = new Set([...revealed].filter((item) => item.startsWith(`${link.id} `)).map((item) => item.slice(link.id.length + 1)));
            const { shown, hiddenEmpty } = visibleProjects(own.filter(matches), { revealed: revealedHere, showEmpty: showEmpty.includes(link.id), filtering: query.trim() !== '' });
            const list = [
              ...shown.map(renderProject),
              hiddenEmpty > 0 && (
                <button key="reveal" type="button" data-nav-row className="sidebar-reveal" onClick={() => {
                  const first = own.filter(matches).find((p) => p.sessions.length === 0 && !p.is_inbox);
                  if (first) setFocusProject(`${link.id} ${first.id}`);
                  setShowEmpty((ids) => (ids.includes(link.id) ? ids : [...ids, link.id]));
                }}>
                  <FolderClosed size={13} className="sidebar-project-icon" aria-hidden="true" />
                  <span>{hiddenEmpty} {hiddenEmpty === 1 ? 'project' : 'projects'} with no sessions</span>
                </button>
              ),
            ];
            if (!desktop) {
              return <Fragment key={link.id}>
                {inventoryAvailable && own.length === 0 && (
                  <p className="glass-inventory-error">
                    No projects yet. Use + to open your first project.
                  </p>
                )}
                {list}
                {!query && (otherBy[link.id]?.length ?? 0) > 0 && (
                  <Suspense fallback={null}>
                    <OtherSessions
                      machine={link.id}
                      sessions={otherBy[link.id]}
                      stateOf={(s) => sessionState(s, seenAt(link.id, OTHER_PROJECT_KEY, s.name))}
                      opening={new Set([...openingOther.current].filter((item) => item.startsWith(`${link.id} `)).map((item) => item.slice(link.id.length + 1)))}
                      onOpen={(session) => void openOther(link, session)}
                    />
                  </Suspense>
                )}
              </Fragment>;
            }
            const collapsed = collapsedMachines.includes(link.id);
            const loadedHere = link.id in projectsBy;
            return (
              <MachineSection
                key={link.id}
                link={link}
                count={own.length}
                collapsed={collapsed}
                onToggle={() => setCollapsedMachines((ids) => collapsed ? ids.filter((id) => id !== link.id) : [...ids, link.id])}
                onAddProject={() => setPickingProject(link.id)}
                onOpenPanel={(kind) => setPanel({ kind, machine: link.id })}
              >
                {link.state === 'connected' && loadedHere && !own.some((p) => p.path && !p.is_inbox) && !query && (
                  <Suspense fallback={null}>
                    <ApiContext.Provider value={clientOf(link) ?? api}>
                      <DesktopStart
                        machine={link.id === 'local' ? undefined : link.label}
                        onOpenFolder={() => setPickingProject(link.id)}
                        onConnect={link.id === 'local' && canConnect() ? () => setConnecting(true) : undefined}
                        onLink={(repo) => linkProject(link.id, repo.path, repo.name)}
                        onInstall={(agent) => {
                          const startup = trustedInstallStart(agent);
                          if (!startup) { setError(`Dolphin does not know this installer for ${agent.name}. ${agent.install_hint ?? 'Install it yourself.'}`); return; }
                          const inbox = inboxOf(link.id);
                          if (!inbox) { setError('This machine has no Inbox project yet, so there is nowhere to open a terminal.'); return; }
                          return create(inbox, { mode: 'shell', startup });
                        }}
                        onSignIn={(agent) => {
                          const inbox = inboxOf(link.id);
                          if (!inbox) { setError('This machine has no Inbox project yet, so there is nowhere to open a terminal.'); return; }
                          return create(inbox, { mode: agent });
                        }}
                      />
                    </ApiContext.Provider>
                  </Suspense>
                )}
                {list}
                {!query && (otherBy[link.id]?.length ?? 0) > 0 && (
                  <Suspense fallback={null}>
                    <OtherSessions
                      machine={link.id}
                      sessions={otherBy[link.id]}
                      stateOf={(s) => sessionState(s, seenAt(link.id, OTHER_PROJECT_KEY, s.name))}
                      opening={new Set([...openingOther.current].filter((item) => item.startsWith(`${link.id} `)).map((item) => item.slice(link.id.length + 1)))}
                      onOpen={(session) => void openOther(link, session)}
                    />
                  </Suspense>
                )}
              </MachineSection>
            );
          })}
          {desktop && canConnect() && (
            <button type="button" className="glass-connect-machine" onClick={() => setConnecting(true)}>
              <Server size={15} aria-hidden="true" />
              <span>Connect to a Machine…</span>
            </button>
          )}
        </div>
        </motion.div>}
        {!narrow && !sidebarCollapsed && <SidebarResizer width={sidebarWidth} onChange={setSidebarWidth} onCommit={commitSidebarWidth} />}
      </motion.aside>
      <Group
        className="glass-center"
        elementRef={centre}
        orientation={narrow ? 'vertical' : 'horizontal'}
        resizeTargetMinimumSize={{ coarse: 24, fine: 8 }}
        onLayoutChanged={(_layout, meta) => {
          // Only a person's drag or key press sets the remembered width.
          if (!meta.isUserInteraction || !hasWindowsRef.current || narrowRef.current) return;
          const chat = chatPanel.current;
          if (!chat) return;
          if (chat.isCollapsed()) rememberChat(true);
          else {
            chatWidth.current = clampChatWidth(chat.getSize().inPixels);
            writeLayout(storage, LAYOUT_KEYS.chat, { width: chatWidth.current, collapsed: false });
          }
        }}
      >
      {/* Never collapsible: a drag to the edge stops at 30% while windows are open. */}
      <Panel id="dolphin-windows" panelRef={windowsPanel} minSize={hasWindows ? '30%' : '0%'} defaultSize="0%">
        {/* A closing window leaves the flow at once (popLayout) so the others
            move into its place while it fades; it keeps its size, so its
            terminal is never resized on the way out. */}
        <motion.div ref={windowStack} className="glass-window-stack" data-multiple={projectWindows.length > 1} layoutScroll>
          <AnimatePresence initial={false} mode="popLayout">
            {projectWindows.map(group => {
              // Only a stacked, open, windowed window has an edge; the others keep their CSS height.
              const resizable = projectWindows.length > 1 && !group.collapsed && fullscreenProject !== group.projectId;
              const height = windowHeights[group.projectId];
              return <motion.section layout="position" layoutDependency={layoutKey} key={group.projectId} className="glass-session-window glass-surface" data-session-key={key(group.selected)} data-project-id={group.projectId} data-active={active?.projectId === group.projectId} data-fullscreen={fullscreenProject === group.projectId || undefined} style={resizable && height ? { height } : undefined} variants={windowVariants} {...presence} transition={settleTransition}>
              {group.sessions.map(target => <div key={key(target)} className="glass-project-terminal" hidden={key(target) !== key(group.selected)}>
                <ApiContext.Provider value={apiOf(machineOfTarget(target)) ?? api}>
                <GlassSessionWindow
                  target={target}
                  sessions={group.sessions}
                  machineId={machineOfTarget(target)}
                  machine={desktop && machineOfTarget(target) !== 'local' ? labelOf(machineOfTarget(target)) : undefined}
                  visible={key(target) === key(group.selected)}
                  collapsed={group.collapsed}
                  fullscreen={fullscreenProject === group.projectId}
                  pinned={focus.some((item) => key(item) === key(target))}
                  state={stateOfTarget(target)}
                  states={Object.fromEntries(group.sessions.map((t) => [key(t), stateOfTarget(t)]))}
                  reconnectKey={terminalReconnectKey(target, projects, sections, desktop)}
                  git={gitBy[machineOfTarget(target) ?? '']?.sessions?.[target.sessionName] ?? gitBy[machineOfTarget(target) ?? '']?.projects?.[target.projectId] ?? null}
                  creating={creating}
                  onSelectTab={selectTabStable}
                  onCloseTab={closeWindowStable}
                  onToggleFullscreen={toggleFullscreenStable}
                  onNewSession={newSessionInStable}
                  onToggleCollapsed={toggleCollapsedStable}
                  onTogglePin={togglePinStable}
                  onReviewChanges={reviewStable}
                  onClose={closeWindowStable}
                  onTerminated={terminatedStable}
                  onFocus={focusTargetStable}
                  onChanged={refreshAllStable}
                />
                </ApiContext.Provider>
              </div>)}
              {resizable && <WindowHeightResizer
                label={group.selected.projectName || group.projectId}
                remembered={height ?? null}
                min={windowLimits.min}
                max={windowLimits.max}
                stack={() => windowStack.current}
                target={() => windowOf(group.projectId)}
                onCommit={(next) => commitWindowHeight(group.projectId, next)}
              />}
            </motion.section>;
            })}
          </AnimatePresence>
        </motion.div>
      </Panel>
      <Separator
        className="glass-window-separator"
        aria-label="Resize chat and session windows"
        disabled={!hasWindows || chatCollapsed}
        style={{
          visibility: hasWindows && !chatCollapsed ? 'visible' : 'hidden',
          width: narrow ? undefined : (hasWindows && !chatCollapsed ? 6 : 0),
          height: narrow ? (hasWindows && !chatCollapsed ? 6 : 0) : undefined,
        }}
      />
      <Panel id="dolphin-chat" panelRef={chatPanel} collapsible collapsedSize="0%" minSize={narrow ? '20%' : `${CHAT_MIN_WIDTH}px`} defaultSize="100%" groupResizeBehavior={hasWindows && !narrow ? 'preserve-pixel-size' : 'preserve-relative-size'}>
      {/* Folded, the chat stays mounted (its drafts and replies keep running) but out of sight. */}
      <main ref={chatMain} className="glass-stage glass-surface" hidden={hasWindows && chatCollapsed}>
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
              {hasWindows && (
                <button className="glass-chat-fold" aria-label="Hide chat" title={`Hide chat (${foldShortcut(mac)})`} onClick={foldChat}>
                  <PanelRightClose size={15} aria-hidden="true" />
                </button>
              )}
            </div>
        </header>
        {error && (
          <div role="alert" className="glass-error">
            {error}
            {failedMessage && <button disabled={busy || pending} onClick={() => { composer.current?.clearIf(failedMessage); void send(failedMessage); }}>Retry failed message</button>}
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
                  <h2>What shall we work on?</h2>
                  <p>Ask about your projects, or open a session from the list. Replies, and the work they start, show up here.</p>
                  <div>
                    <button onClick={() => composer.current?.setDraft('Give me an overview of my projects.')}>
                      Get an Overview <ArrowUpRight size={14} />
                    </button>
                    <button onClick={() => composer.current?.setDraft('Help me decide what to focus on next.')}>
                      Find My Next Focus <ArrowUpRight size={14} />
                    </button>
                  </div>
                </div>
              ) : (
                visibleMessages.map((m, index) => (
                  <Fragment key={m.id}>
                  {renderWorkUpdates(workAt.get(index) ?? [])}
                  <motion.article key={m.id} className={`glass-message ${m.role}`} data-arrived={arrived.has(m.id) || undefined} variants={arrivalVariants} initial={arrived.has(m.id) ? 'hidden' : false} animate="shown">
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
                        <>{m.payload?.engine && <small className="glass-engine-label" title={m.payload.engine.model}>{m.payload.engine.provider === 'claude' ? 'Claude Code' : 'Codex'}{m.payload.engine.fallback ? ' · fallback' : ''}</small>}{m.payload?.tool_activity && renderActivity(m.payload.tool_activity)}<MarkdownReply text={m.text} />{m.payload?.uncertainty_note && <p className="glass-context-note">{m.payload.uncertainty_note}</p>}</>
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
              <LiveReply key={tabId} thread={thread} running={busy || pending} lastRole={visibleMessages[visibleMessages.length - 1]?.role} renderActivity={renderActivity} onGrow={followIfTailing} onStreaming={setStreaming} />
            </div>
            <BrainStatus />
            {desktop && <AgentSetupPrompt sources={machineSources} onHolding={setSetupHolding} />}
            {desktop && <Suspense fallback={null}><SkillSuggestions /></Suspense>}
            {renderSignals?.((text) => composer.current?.setDraft(text))}
            <ChatComposer ref={composer} tabId={tabId} disabled={busy || pending} onSend={(text) => void send(text)} />
      </main>
      </Panel>
      </Group>
      {/* Keyed by session: moving to another row cross-fades the two previews. */}
      <AnimatePresence>{glance.shown && <GlancePopover key={glance.shown.target.key} shown={glance.shown} onClose={glance.hide} />}</AnimatePresence>
    </div></MotionDialogs></MotionConfig>
  );
}
