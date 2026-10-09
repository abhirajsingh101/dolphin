import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { Maximize2, Minimize2, Minus, Plus, Terminal, X } from 'lucide-react';
import { TerminalRuntimeProvider } from '@dolphin-terminal/react/runtime';
import { dolphinTerminalClient } from './dolphinTerminalClient';
import { fetchWorkspace } from './api';
import { useDictation } from './DictationProvider';
import type { TmuxSession } from './types';
const TerminalPane = lazy(() => import('@dolphin-terminal/react/pane'));
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
export default function GlassSessionWindow({ target, collapsed, visible = true, tabs, creating = false, fullscreen = false, onToggleFullscreen, onNewSession, onToggleCollapsed, onClose, onTerminated, onFocus, onChanged }: {
  target: { projectId: string; projectName: string; sessionName: string };
  collapsed: boolean; visible?: boolean; tabs?: ReactNode; creating?: boolean; fullscreen?: boolean; onToggleFullscreen?: () => void;
  onNewSession?: () => void; onToggleCollapsed: () => void;
  onClose: () => void; onTerminated: () => void; onFocus: () => void; onChanged: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
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
    const updateInput = (event: Event) => {
      if (event.target instanceof Element && element.contains(event.target)
        && event.target.closest('.glass-terminal-mode')) return;
      setInteraction(ownsInput(event.target));
    };
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
  const label = `${target.projectName} / ${target.sessionName}`;
  return <div ref={root} className="glass-window-content" data-interacting={interacting} data-collapsed={collapsed} onFocusCapture={onFocus} onPointerDown={onFocus}>
    <header className="glass-window-title">
      <Terminal size={15} /><h2 aria-label={label}>{tabs ? target.projectName : label}</h2>{tabs}
      {onNewSession && !collapsed && <button className="glass-new-terminal-tab" aria-label={`New terminal session in ${target.projectName}`} title="New tmux session in this project" disabled={creating} onClick={onNewSession}><Plus size={14} /></button>}
      {!collapsed && <button className="glass-terminal-mode" aria-pressed={interacting}
        aria-label={interacting ? 'Browse windows' : 'Interact with terminal'}
        title={interacting ? 'Scroll controls this terminal. Click to browse windows.' : 'Scroll to browse windows. Click inside the terminal to interact.'}
        onClick={() => {
          if (interacting) setInteraction(false);
          else {
            const input = root.current?.querySelector<HTMLElement>('.terminal-copy-layer')
              ?? root.current?.querySelector<HTMLElement>('.xterm-helper-textarea');
            input?.focus();
            setInteraction(true);
          }
        }}>{interacting ? 'Interacting' : 'Browse'}</button>}
      {onToggleFullscreen && !collapsed && <button className="glass-window-fullscreen" aria-pressed={fullscreen}
        aria-label={`${fullscreen ? 'Exit fullscreen' : 'Fullscreen'} ${target.projectName}`}
        title={fullscreen ? 'Exit fullscreen (Esc outside the terminal)' : 'Fullscreen this project, with its tabs'}
        onClick={onToggleFullscreen}>{fullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}</button>}
      <button aria-label={`${collapsed ? 'Restore' : 'Minimize'} ${label}`} onClick={onToggleCollapsed}>{collapsed ? <Plus size={14} /> : <Minus size={14} />}</button>
      <button aria-label={`Close window ${label}`} title="Close view — tmux keeps running" onClick={onClose}><X size={14} /></button>
    </header>
    <div className="glass-terminal" hidden={collapsed}>
      {error ? <p role="alert">{error}</p> : <TerminalRuntimeProvider client={dolphinTerminalClient} dictation={dictation} automation={false}>
        <Suspense fallback={<p>Loading terminal…</p>}>
          {session ? <TerminalPane enableWebgl={false} theme={glassTerminalTheme} projectId={target.projectId} session={session} onSessionChanged={onChanged} onSessionClosed={() => { onTerminated(); onChanged(); }} /> : <p>Connecting…</p>}
        </Suspense>
      </TerminalRuntimeProvider>}
    </div>
  </div>;
}
