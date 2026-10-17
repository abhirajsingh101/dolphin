import { lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { indicatorTransition } from './motion/presets';
import { AnimatePresence, motion } from 'motion/react';
import { MotionPopover, useOverlayLayer } from './motion/MotionDialog';
import StatusGlyph from './StatusGlyph';
import type { SessionState } from './sessionState';
import { GitCompare, Maximize2, Minimize2, Minus, MoreHorizontal, Pin, Plus, Power, RefreshCw, TextSelect, X } from 'lucide-react';
import { isPlainTerminal, sessionLabel, targetKey, type Target } from './workspace/targets';
import { sameWindowProps } from './workspace/windowProps';
import { loadTerminalFeatures, loadTerminalPane } from './workspace/prefetch';
import { HIDDEN_DETACH_MS, useLinger } from './workspace/useLinger';
import { CLOSE_SESSION, PANE_CONNECTION_PILL, PANE_TITLES, PANE_TOOLBAR, RECONNECT, SELECT } from './terminal/paneToolbar';
import TerminalActivityBadge from './terminal/TerminalActivityBadge';
import { TerminalRuntimeProvider } from '@dolphin-terminal/react/runtime';
import { terminalClientFor } from './dolphinTerminalClient';
import { useApi } from './apiContext';
import { useDictation } from './DictationProvider';
import GitBadge from './GitBadge';
import type { GitStatus, TmuxSession } from './types';
import type { Terminal as Xterm } from '@xterm/xterm';
import { openLink } from './openLink';
import type { TerminalFeatureOptions, TerminalFeatures } from './terminal';
import { terminalKey } from './terminal/terminalKey';
import { clearTerminalBell } from './terminal/activity';
import TerminalFind from './terminal/TerminalFind';
import { registerFindTarget } from './terminal/commands';
import { FIND_SNAPSHOT_LINES } from './terminal/find';
import { copyNotice, copyNoticeMs } from './terminal/osc52';
import { currentPlatform, isMacPlatform } from './shortcutLabel';
import { desktopOwnsTerminalShortcuts } from './terminal/platform';
/* The pane and the features arrive together: onTerminal runs only after the
   pane has rendered, so the features are always loaded by then. */
let attachTerminalFeatures: typeof import('./terminal').attachTerminalFeatures | null = null;
const TerminalPane = lazy(() => Promise.all([loadTerminalPane(), loadTerminalFeatures()]).then(([pane, features]) => {
  attachTerminalFeatures = features.attachTerminalFeatures;
  return pane;
}));
// xterm WebGL forces opaque backgrounds for dim cells (RectangleRenderer).
// Use its DOM renderer for glass; re-enable WebGL when upstream preserves alpha.
// Transparent renderer lets the host glass surface show through; ANSI colors
// remain legible on the smoked surface in both dashboard modes.
const glassTerminalTheme = {
  background: '#00000000', foreground: '#dce7f5', cursor: '#8cbcff',
  cursorAccent: '#15283d', selectionBackground: '#527da866',
  black: '#14263a', brightBlack: '#91a3b9', red: '#f08f99',
  green: '#69c9a6', yellow: '#e7c58a', blue: '#83b8f5',
  magenta: '#bea5ef', cyan: '#80cedb', white: '#dce7f5',
  brightRed: '#ffadb5', brightGreen: '#92dfc2', brightYellow: '#f3d9a8',
  brightBlue: '#a8ceff', brightMagenta: '#d5bfff', brightCyan: '#a4e4ed', brightWhite: '#f4f8ff',
};
export type SessionWindowProps = {
  target: Target;
  sessions: Target[];
  /** Dolphin Desktop: the machine the session runs on, when it isn't this computer. */
  machine?: string;
  /** The machine's id (`local` for this computer), for per-session state. */
  machineId?: string;
  collapsed: boolean;
  visible?: boolean;
  creating?: boolean;
  fullscreen?: boolean;
  pinned?: boolean;
  /** The selected session's state (status area), shown first in the header. */
  state?: SessionState;
  /** Per-tab states, by targetKey. */
  states?: Record<string, SessionState>;
  /** `machine:epoch` (reliability area): when it moves, the terminal reconnects. */
  reconnectKey?: string;
  /** The session's worktree, or else its project's, branch and changes. Same reference until it changes. */
  git?: GitStatus | null;
  onSelectTab: (target: Target) => void;
  onCloseTab: (target: Target) => void;
  onToggleFullscreen?: (projectId: string) => void;
  onNewSession?: (projectId: string, ask?: boolean) => void;
  onToggleCollapsed: (projectId: string) => void;
  onTogglePin?: (target: Target) => void;
  /** Opens the session's diff panel; a stable callback taking the target. */
  onReviewChanges?: (target: Target) => void;
  onClose: (target: Target) => void;
  onTerminated: (target: Target) => void;
  onFocus: (target: Target) => void;
  onChanged: () => void;
};

/** The package's connection state, read from its (hidden) toolbar pill. */
function usePaneConnection(root: RefObject<HTMLElement | null>, generation: unknown): string {
  const [state, setState] = useState('connecting');
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    let pillObserver: MutationObserver | null = null;
    const watch = () => {
      const pill = element.querySelector(`.${PANE_CONNECTION_PILL}`);
      if (!pill) return false;
      const read = () => setState([...pill.classList].find((name) => name !== PANE_CONNECTION_PILL) ?? 'connecting');
      read();
      pillObserver?.disconnect();
      pillObserver = new MutationObserver(read);
      pillObserver.observe(pill, { attributes: true, attributeFilter: ['class'] });
      return true;
    };
    if (watch()) return () => pillObserver?.disconnect();
    const mount = new MutationObserver(() => { if (watch()) mount.disconnect(); });
    mount.observe(element, { childList: true, subtree: true });
    return () => { mount.disconnect(); pillObserver?.disconnect(); };
  }, [root, generation]);
  return state;
}

/** A pane toolbar button the menu runs: its current title, and whether the package disabled it. */
type PaneAction = { title: string; disabled: boolean } | null;
const UNAVAILABLE = 'Not available until the terminal session is ready';
const MENU_WIDTH = 220;
const MENU_GUTTER = 8;

/* The window's one overflow menu: the package toolbar's actions (hidden in
   glass), plus pinning. It sits in a layer above the window stack, under its
   button (above it when there is no room below) and inside the viewport. */
function WindowMenu({ label, pane, pinned, onTogglePin, onReviewChanges }: { label: string; pane: RefObject<HTMLElement | null>; pinned: boolean; onTogglePin?: () => void; onReviewChanges?: () => void }) {
  const [open, setOpen] = useState(false);
  const [layer, layerGone] = useOverlayLayer(open);
  const [place, setPlace] = useState<{ top: number; left: number; side: 'below' | 'above' }>({ top: 0, left: 0, side: 'below' });
  const [actions, setActions] = useState<{ select: PaneAction; reconnect: PaneAction; close: PaneAction }>({ select: null, reconnect: null, close: null });
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const find = (selector: string) => pane.current?.querySelector<HTMLButtonElement>(selector) ?? null;
  const action = (selector: string): PaneAction => {
    const found = find(selector);
    return found ? { title: found.title, disabled: found.disabled } : null;
  };
  const dismiss = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) button.current?.focus();
  };
  // The item the menu focused itself; any other focused item is the user's, and stays.
  const autoFocused = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    autoFocused.current = null;
    setActions({ select: action(SELECT), reconnect: action(RECONNECT), close: action(CLOSE_SESSION) });
  }, [open]);
  // When the items change, the focus stays on the item the user is on, if it is
  // still there; otherwise (or when the menu put it there) it goes to the first.
  useLayoutEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
      const current = document.activeElement as HTMLElement | null;
      if (current && items.includes(current) && current !== autoFocused.current) return;
      autoFocused.current = items[0] ?? null;
      items[0]?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open, actions]);
  // Opened before the terminal finished loading, the menu picks its actions up
  // when the package's toolbar arrives, and follows their titles while open. It
  // watches the toolbar alone: the terminal's rows beside it change constantly.
  useEffect(() => {
    const element = pane.current;
    if (!open || !element) return;
    const same = (a: PaneAction, b: PaneAction) => a === b || (!!a && !!b && a.title === b.title && a.disabled === b.disabled);
    const read = () => setActions((current) => {
      const next = { select: action(SELECT), reconnect: action(RECONNECT), close: action(CLOSE_SESSION) };
      return same(current.select, next.select) && same(current.reconnect, next.reconnect) && same(current.close, next.close) ? current : next;
    });
    const observers: MutationObserver[] = [];
    let watched: Element | null | undefined;
    const attach = () => {
      const toolbar = element.querySelector(PANE_TOOLBAR);
      if (toolbar === watched) return;
      watched = toolbar;
      observers.splice(0).forEach((observer) => observer.disconnect());
      read();
      const observe = (target: Node, options: MutationObserverInit, callback: () => void) => {
        const observer = new MutationObserver(callback);
        observer.observe(target, options);
        observers.push(observer);
      };
      if (!toolbar) {
        // No terminal yet, so nothing churns: wait for the toolbar to mount.
        observe(element, { childList: true, subtree: true }, attach);
        return;
      }
      observe(toolbar, { childList: true, subtree: true, attributes: true, attributeFilter: ['title', 'disabled'] }, read);
      // A replaced toolbar (the pane remounted) is picked up again.
      if (toolbar.parentElement) observe(toolbar.parentElement, { childList: true }, attach);
      const terminal = element.querySelector('.glass-terminal');
      if (terminal) observe(terminal, { childList: true }, attach);
    };
    attach();
    return () => observers.forEach((observer) => observer.disconnect());
  }, [open]);
  // Placed once its items are known, so its height is real.
  useLayoutEffect(() => {
    if (!open) return;
    const box = button.current?.getBoundingClientRect();
    if (!box) return;
    const height = menu.current?.offsetHeight ?? 0;
    const below = box.bottom + 4;
    const top = below + height <= window.innerHeight - MENU_GUTTER ? below : Math.max(MENU_GUTTER, box.top - 4 - height);
    const left = Math.max(MENU_GUTTER, Math.min(box.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - MENU_GUTTER));
    const side = top >= box.bottom ? 'below' : 'above';
    setPlace((current) => (current.top === top && current.left === left && current.side === side ? current : { top, left, side }));
  }, [open, actions]);
  useEffect(() => {
    if (!open) return;
    const inside = (event: Event) => !!(button.current?.contains(event.target as Node) || menu.current?.contains(event.target as Node));
    const pointer = (event: Event) => { if (!inside(event)) setOpen(false); };
    // Escape in the menu is onMenuKey's; anywhere else, the ⋯ button included
    // (the menu takes the focus a frame after it opens), it closes the menu.
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape' && !menu.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('keydown', key);
    document.addEventListener('pointerdown', pointer);
    const resize = () => setOpen(false);
    window.addEventListener('resize', resize);
    return () => {
      document.removeEventListener('keydown', key);
      document.removeEventListener('pointerdown', pointer);
      window.removeEventListener('resize', resize);
    };
  }, [open]);
  const run = (selector: string) => {
    const target = find(selector);
    // A button the package disabled (no session yet) does nothing; the menu stays open.
    if (!target || target.disabled) return;
    setOpen(false);
    target.click();
  };
  /* aria-disabled rather than disabled, so the item stays focusable and its reason readable. */
  const availability = (item: PaneAction) => (item?.disabled ? { 'aria-disabled': true, title: UNAVAILABLE } : {});
  const onMenuKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      // Escape here closes the menu only: not the find bar, not fullscreen.
      event.preventDefault();
      event.stopPropagation();
      dismiss(true);
      return;
    }
    if (event.key === 'Tab') {
      // Leave from the ⋯ button: the browser's own Tab then moves on from there,
      // not from the menu's place at the end of the workspace.
      button.current?.focus();
      setOpen(false);
      return;
    }
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    if (!items.length) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next = event.key === 'ArrowDown' ? (index + 1) % items.length
      : event.key === 'ArrowUp' ? (index - 1 + items.length) % items.length
        : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    items[next]?.focus();
  };
  return (
    <>
      <button ref={button} type="button" className="glass-window-more" aria-label={`More actions for ${label}`} title="More actions" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <MoreHorizontal size={14} aria-hidden="true" />
      </button>
      {layer && createPortal(
        <AnimatePresence onExitComplete={layerGone}>
        {open && (
        <MotionPopover key="menu" ref={menu} side={place.side} align="right" className="glass-window-menu" role="menu" aria-label={`Actions for ${label}`} style={{ top: place.top, left: place.left }} onKeyDown={onMenuKey}>
          {actions.select && (
            <button type="button" role="menuitem" tabIndex={-1} {...availability(actions.select)} onClick={() => run(SELECT)}>
              <TextSelect size={14} aria-hidden="true" />{actions.select.title === PANE_TITLES.exitSelect ? 'Exit Select Mode' : 'Select Text'}
            </button>
          )}
          {actions.reconnect && (
            <button type="button" role="menuitem" tabIndex={-1} {...availability(actions.reconnect)} onClick={() => run(RECONNECT)}>
              <RefreshCw size={14} aria-hidden="true" />{actions.reconnect.title === PANE_TITLES.reconnect ? 'Reconnect' : 'Refresh'}
            </button>
          )}
          {onTogglePin && (
            <button type="button" role="menuitem" tabIndex={-1} onClick={() => { dismiss(true); onTogglePin(); }}>
              <Pin size={14} aria-hidden="true" />{pinned ? 'Unpin from Sidebar' : 'Pin to Sidebar'}
            </button>
          )}
          {onReviewChanges && (
            <button type="button" role="menuitem" tabIndex={-1} onClick={() => { dismiss(true); onReviewChanges(); }}>
              <GitCompare size={14} aria-hidden="true" />Review Changes…
            </button>
          )}
          {actions.close && (
            <button type="button" role="menuitem" tabIndex={-1} className="glass-window-menu-danger" {...availability(actions.close)} onClick={() => run(CLOSE_SESSION)}>
              <Power size={14} aria-hidden="true" />Close Session…
            </button>
          )}
        </MotionPopover>
        )}
        </AnimatePresence>,
        button.current?.closest('.glass-workspace') ?? document.body,
      )}
    </>
  );
}

function GlassSessionWindowView(props: SessionWindowProps) {
  const { target, sessions, machine, machineId, collapsed, visible = true, creating = false, fullscreen = false, pinned = false, state, states, reconnectKey, git, onSelectTab, onCloseTab, onToggleFullscreen, onNewSession, onToggleCollapsed, onTogglePin, onReviewChanges, onClose, onTerminated, onFocus, onChanged } = props;
  const root = useRef<HTMLDivElement>(null);
  // How many times this window rendered, on its root (glass-performance.spec.ts).
  const renders = useRef(0);
  renders.current += 1;
  useLayoutEffect(() => { root.current?.setAttribute('data-renders', String(renders.current)); });
  const [interacting, setInteracting] = useState(false);
  const interactingRef = useRef(false);
  const setInteraction = (value: boolean) => {
    interactingRef.current = value;
    setInteracting(value);
    if (!value && document.activeElement instanceof HTMLElement
      && root.current?.contains(document.activeElement)
      && document.activeElement.closest('.terminal-xterm-host, .terminal-copy-layer')) document.activeElement.blur();
  };
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const ownsInput = (target: EventTarget | null) => target instanceof Element
      && element.contains(target) && !!target.closest('.terminal-xterm-host, .terminal-copy-layer');
    const updateInput = (event: Event) => setInteraction(ownsInput(event.target));
    const pointer = updateInput;
    const focus = updateInput;
    const wheel = (event: WheelEvent) => {
      // Fullscreen keeps the terminal's existing input and scrolling behavior.
      if (event.ctrlKey || interactingRef.current || !(event.target instanceof Element)
        || event.target.closest('.terminal-pane.fullscreen, [data-fullscreen="true"]')
        || !event.target.closest('.terminal-host')) return;
      const stack = element.closest('.glass-window-stack');
      if (!stack) return;
      event.preventDefault();
      event.stopPropagation();
      const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? stack.clientHeight : 1;
      stack.scrollTop += event.deltaY * scale;
    };
    // Consume any unhandled wheel default after xterm has handled the gesture;
    // reaching the end of terminal history must not move its surrounding window.
    const containWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && event.target instanceof Element
        && event.target.closest('.terminal-host')
        && !event.target.closest('.terminal-pane.fullscreen')) event.preventDefault();
    };
    document.addEventListener('pointerdown', pointer, true);
    document.addEventListener('focusin', focus, true);
    element.addEventListener('wheel', wheel, { capture: true, passive: false });
    element.addEventListener('wheel', containWheel, { passive: false });
    return () => {
      document.removeEventListener('pointerdown', pointer, true);
      document.removeEventListener('focusin', focus, true);
      element.removeEventListener('wheel', wheel, true);
      element.removeEventListener('wheel', containWheel);
    };
  }, []);
  useEffect(() => { if (collapsed || !visible) setInteraction(false); }, [collapsed, visible]);
  // Entering fullscreen, or switching tabs inside it, hands the keyboard to the visible terminal.
  useEffect(() => {
    if (!fullscreen || !visible || collapsed) return;
    const frame = requestAnimationFrame(() => {
      const input = root.current?.querySelector<HTMLElement>('.terminal-copy-layer')
        ?? root.current?.querySelector<HTMLElement>('.xterm-helper-textarea');
      if (input) { input.focus({ preventScroll: true }); setInteraction(true); }
    });
    return () => cancelAnimationFrame(frame);
  }, [fullscreen, visible, collapsed]);
  const dictation = useDictation();
  const api = useApi();
  const { fetchWorkspace } = api;
  const terminalClient = useMemo(() => terminalClientFor(api), [api]);
  const terminalId = terminalKey(machineId, target.projectId, target.sessionName);
  const clientRef = useRef(terminalClient);
  clientRef.current = terminalClient;
  const targetRef = useRef(target);
  targetRef.current = target;
  const mac = isMacPlatform(currentPlatform());
  const [notice, setNotice] = useState<{ id: number; text: string; ms: number } | null>(null);
  const showNotice = useCallback((text: string, ms: number) => {
    setNotice((current) => ({ id: (current?.id ?? 0) + 1, text, ms }));
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice((current) => (current?.id === notice.id ? null : current)), notice.ms);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const [findOpen, setFindOpen] = useState(false);
  const [findFocus, setFindFocus] = useState(0);
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;
  const toggleRef = useRef(() => onToggleCollapsed(target.projectId));
  toggleRef.current = () => onToggleCollapsed(target.projectId);
  // A collapsed window is restored first: find never opens an invisible bar.
  const openFind = useCallback(() => {
    if (collapsedRef.current) toggleRef.current();
    setFindOpen(true);
    setFindFocus((n) => n + 1);
  }, []);
  useEffect(() => registerFindTarget(terminalId, openFind), [terminalId, openFind]);
  const loadHistory = useCallback(
    () => clientRef.current.fetchSnapshot(target.projectId, target.sessionName, FIND_SNAPSHOT_LINES).then((snapshot) => snapshot.content),
    [target.projectId, target.sessionName],
  );
  const closeFind = useCallback(() => {
    setFindOpen(false);
    requestAnimationFrame(() => root.current?.querySelector<HTMLElement>('.xterm-helper-textarea')?.focus());
  }, []);
  const foregroundRef = useRef(false);
  foregroundRef.current = visible && !collapsed;
  useEffect(() => { if (visible && !collapsed) clearTerminalBell(terminalId); }, [visible, collapsed, terminalId]);
  const fullscreenActive = fullscreen && visible && !collapsed;
  const fullscreenRef = useRef(fullscreenActive);
  fullscreenRef.current = fullscreenActive;
  useEffect(() => { featuresRef.current?.setFullscreen(fullscreenActive); }, [fullscreenActive]);
  // Read once by onTerminal when the terminal opens. Anything that changes
  // later is read through a ref inside these functions.
  const featureOptions: TerminalFeatureOptions = {
    mac,
    onFind: openFind,
    appShortcuts: () => !desktopOwnsTerminalShortcuts(),
    onCopied: (ok) => showNotice(copyNotice(ok, mac), copyNoticeMs(ok)),
    resolvePaths: (candidates) => clientRef.current.resolvePaths(targetRef.current.projectId, targetRef.current.sessionName, candidates),
    fileUrl: (path) => clientRef.current.fileDownloadUrl(path),
    activityKey: terminalId,
    openWeb: (href) => void openLink(href, machineId),
    isForeground: () => foregroundRef.current && document.hasFocus(),
    opaqueBackground: () => getComputedStyle(document.documentElement).getPropertyValue('--glass-term-solid'),
  };
  const featureOptionsRef = useRef(featureOptions);
  featureOptionsRef.current = featureOptions;
  const featuresRef = useRef<TerminalFeatures | null>(null);
  const onTerminal = useCallback((terminal: Xterm) => {
    if (!attachTerminalFeatures) throw new Error('Terminal features are not loaded.');
    const features = attachTerminalFeatures(terminal, featureOptionsRef.current);
    featuresRef.current = features;
    features.setFullscreen(fullscreenRef.current);
    return () => {
      features.dispose();
      if (featuresRef.current === features) featuresRef.current = null;
    };
  }, []);
  const [session, setSession] = useState<TmuxSession | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let current = true;
    fetchWorkspace(target.projectId).then((workspace) => {
      if (!current) return;
      const found = workspace.sessions.find((item) => item.name === target.sessionName);
      setSession(found ?? null);
      if (!found) setError('This session is no longer available.');
    }).catch(() => { if (current) setError('Could not connect to this session. Close and reopen to retry.'); });
    return () => { current = false; };
  }, [target.projectId, target.sessionName]);
  const label = `${target.projectName} / ${sessionLabel(target.sessionName)}`;
  /* Hidden tabs and minimized windows let go of their terminal after a minute.
     A tab that has never been shown never attaches: it has no size to report,
     and a socket opened at 80x24 can shrink the real tmux window. */
  const attached = useLinger(visible && !collapsed, HIDDEN_DETACH_MS);
  const paneConnection = usePaneConnection(root, attached ? session : null);
  // A parked pane has nothing behind the dot: no stale "connected", no Reconnect.
  const connection = session && !attached ? 'parked' : paneConnection;
  // 'reconnecting' is left out on purpose: the package is already retrying
  // on its own (retryAfterDrop), so a button would only race it. It shows once
  // the retries give up and the state settles on closed, error or offline.
  const broken = connection === 'closed' || connection === 'error' || connection === 'offline';
  const selectedIndex = sessions.findIndex((item) => targetKey(item) === targetKey(target));
  const onTabKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const n = sessions.length;
    const next = event.key === 'ArrowRight' ? (selectedIndex + 1) % n : event.key === 'ArrowLeft' ? (selectedIndex - 1 + n) % n : event.key === 'Home' ? 0 : event.key === 'End' ? n - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    onSelectTab(sessions[next]);
    requestAnimationFrame(() => root.current?.closest('.glass-session-window')
      ?.querySelector<HTMLElement>('.glass-project-terminal:not([hidden]) [role="tab"][aria-selected="true"]')?.focus());
  };
  return <div ref={root} className="glass-window-content" data-interacting={interacting} data-collapsed={collapsed}
    onFocusCapture={() => { clearTerminalBell(terminalId); onFocus(target); }} onPointerDown={() => onFocus(target)}
    onKeyDown={(event) => { if (event.key === 'Escape' && findOpen) { event.preventDefault(); event.stopPropagation(); closeFind(); } }}>
    <header className="glass-window-title">
      {state && <StatusGlyph state={state} />}
      <span className="glass-window-link" data-state={connection} role="status" aria-label={`Terminal ${connection}`} title={`Terminal ${connection}`} />
      {machine && <span className="glass-window-machine" title={`Running on ${machine}`}>{machine}</span>}
      <h2 aria-label={machine ? `${label} on ${machine}` : label}>{sessions.length > 1 ? target.projectName : label}</h2>
      <GitBadge status={git} />
      {sessions.length > 1 && (
        <div className="glass-terminal-tabs" role="tablist" aria-label={`Terminal tabs for ${target.projectName}`} onKeyDown={onTabKey}>
          {sessions.map((session) => {
            const selected = targetKey(session) === targetKey(target);
            const tabState = states?.[targetKey(session)];
            return (
              <div className="glass-terminal-tab" key={targetKey(session)} data-selected={selected}>
                <button role="tab" aria-label={sessionLabel(session.sessionName)} aria-selected={selected} tabIndex={selected ? 0 : -1} title={sessionLabel(session.sessionName)} onClick={() => onSelectTab(session)}>
                  {tabState && <StatusGlyph state={tabState} />}{sessionLabel(session.sessionName)}
                </button>
                <TerminalActivityBadge activityKey={terminalKey(session.machine ?? machineId, session.projectId, session.sessionName)} />
                <button aria-label={`Close terminal tab ${sessionLabel(session.sessionName)}`} title={isPlainTerminal(session.sessionName) ? "Close tab — the terminal keeps running" : "Close tab — tmux keeps running"} onClick={(event) => { event.stopPropagation(); onCloseTab(session); }}><X size={12} /></button>
                {/* Every tab of a project renders its own copy of this strip; only the
                    shown one draws the indicator, which glides to the newly shown
                    copy's selected tab. The id is the project window's, so windows
                    never trade indicators. */}
                {selected && visible && <motion.span className="glass-tab-indicator" layoutId={`terminal-tab-indicator:${machineId ?? 'local'}:${target.projectId}`} transition={indicatorTransition} aria-hidden="true" />}
              </div>
            );
          })}
        </div>
      )}
      {onNewSession && !collapsed && <button className="glass-new-terminal-tab" aria-label={`New terminal session in ${target.projectName}`} title="New session in this project (Option or Alt-click to choose what to start)" disabled={creating} onClick={(event) => onNewSession(target.projectId, event.altKey)}><Plus size={14} /></button>}
      {broken && !collapsed && <button className="glass-window-reconnect" aria-label={`Reconnect ${label}`} onClick={() => root.current?.querySelector<HTMLButtonElement>(RECONNECT)?.click()}><RefreshCw size={13} aria-hidden="true" /> Reconnect</button>}
      {!collapsed && <WindowMenu label={label} pane={root} pinned={pinned} onTogglePin={onTogglePin ? () => onTogglePin(target) : undefined} onReviewChanges={onReviewChanges ? () => onReviewChanges(target) : undefined} />}
      {onToggleFullscreen && !collapsed && <button className="glass-window-fullscreen" aria-pressed={fullscreen}
        aria-label={`${fullscreen ? 'Exit fullscreen' : 'Fullscreen'} ${target.projectName}`}
        title={fullscreen ? 'Exit fullscreen (Esc outside the terminal)' : 'Fullscreen this project, with its tabs'}
        onClick={() => onToggleFullscreen(target.projectId)}>{fullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}</button>}
      <button aria-label={`${collapsed ? 'Restore' : 'Minimize'} ${label}`} onClick={() => onToggleCollapsed(target.projectId)}>{collapsed ? <Plus size={14} /> : <Minus size={14} />}</button>
      <button aria-label={`Close window ${label}`} title="Close view — tmux keeps running" onClick={() => onClose(target)}><X size={14} /></button>
    </header>
    <div className="glass-terminal" hidden={collapsed}>
      {error ? <p role="alert">{error}</p> : <TerminalRuntimeProvider client={terminalClient} dictation={dictation} automation={false}>
        <Suspense fallback={<p>Loading terminal…</p>}>
          {session && attached ? <TerminalPane enableWebgl={false} theme={glassTerminalTheme} reconnectKey={reconnectKey} retryAfterDrop onTerminal={onTerminal} projectId={target.projectId} session={session} onSessionChanged={onChanged} onSessionClosed={() => { onTerminated(target); onChanged(); }} /> : session ? <p className="glass-terminal-parked">Paused while hidden. It reconnects when you open this tab.</p> : <p>Connecting…</p>}
        </Suspense>
      </TerminalRuntimeProvider>}
      {findOpen && <TerminalFind load={loadHistory} onClose={closeFind} focusToken={findFocus} />}
      {notice && <p className="glass-terminal-toast" role="status">{notice.text}</p>}
    </div>
  </div>;
}

/* Memoised: the workspace renders on every chat keystroke and reply poll, and a
   window renders only when its own props change (workspace/windowProps.ts). */
export default memo(GlassSessionWindowView, sameWindowProps);
