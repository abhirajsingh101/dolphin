import { useEffect, useState } from 'react';
import { sessionLabel } from './workspace/targets';
import { ChevronDown, Folder, FolderMinus, History as HistoryIcon, Inbox, Pin, Plus } from 'lucide-react';
import StatusGlyph from './StatusGlyph';
import type { SessionState } from './sessionState';
import { elapsed, projectSummary, rowTime } from './sidebarModel';
import GitBadge from './GitBadge';
import { projectAccentVar } from './projectIdentity';
import type { ControlCenterProject, ControlCenterSession, GitStatus, WorktreeStatus } from './types';
import './sidebar.css';

const AGENT_NAME = { claude: 'Claude', codex: 'Codex' } as const;

/** The time, re-read every `intervalMs`, for rows that say how long ago. */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/* One project in the projects list: a 28px row, then one 28px row per session
   with its glyph, name, agent and time. The folder takes the project's colour,
   so projects read apart from machines and from each other. The row's actions
   (+, history, remove) float over its right end on hover or focus and take no
   width otherwise, so the name keeps the row. A collapsed project says what
   its sessions are doing. */
/** What Archive deletes besides the folder's tracked files: git removes ignored files with the worktree. */
function ignoredNote(worktree: WorktreeStatus): string {
  const count = worktree.ignored_count ?? 0;
  if (!count) return '';
  const names = worktree.ignored_names ?? [];
  const more = count - names.length;
  return `Also deletes ${count} ignored ${count === 1 ? 'item' : 'items'}: ${names.join(', ')}${more > 0 ? ` and ${more} more` : ''}.`;
}

export default function SidebarProject({ project, machine, machineLabel, collapsed, selectedSession, stateOf, now, creating, onToggle, onOpen, pinned, onTogglePin, rowProps, onNewSession, onRemove, git, worktreeOf, onArchive, onHistory }: {
  project: ControlCenterProject;
  machine: string;
  /** Shown to assistive technology when more than one machine is listed. */
  machineLabel?: string;
  collapsed: boolean;
  selectedSession: string | null;
  stateOf: (session: ControlCenterSession) => SessionState;
  now: number;
  creating: boolean;
  onToggle: (collapsed: boolean) => void;
  onOpen: (session: ControlCenterSession) => void;
  pinned?: (sessionName: string) => boolean;
  onTogglePin?: (session: ControlCenterSession) => void;
  /** Extra props for a session's open button (the hover glance). Its `aria-describedby` joins the glyph's. */
  rowProps?: (session: ControlCenterSession) => Record<string, unknown>;
  /** `ask`: show the choices even when Settings has a default (Option/Alt-click). */
  onNewSession: (ask?: boolean) => void;
  onRemove?: () => void;
  /** The project's branch and changes. Keep the same reference until it changes (the window is memoised). */
  git?: GitStatus | null;
  /** Worktree sessions (workflow T7/T10): their status, and archive. Not rendered until those tasks land. */
  worktreeOf?: (sessionName: string) => WorktreeStatus | undefined;
  onArchive?: (session: ControlCenterSession) => void;
  /** Transcript history (workflow T18). */
  onHistory?: () => void;
}) {
  const states = project.sessions.map(stateOf);
  const [confirming, setConfirming] = useState<string | null>(null);
  const glyphId = (name: string) => `glyph-${machine}-${project.id}-${name}`.replace(/[^A-Za-z0-9_-]/g, '_');
  return (
    <details className="sidebar-project" open={!collapsed}
      onToggle={(event) => { const open = event.currentTarget.open; if (open === collapsed) onToggle(!open); }}>
      <summary data-nav-row data-project-key={`${machine} ${project.id}`}>
        <ChevronDown size={12} aria-hidden="true" />
        {project.is_inbox
          ? <Inbox size={14} className="sidebar-project-icon" aria-hidden="true" />
          : <Folder size={14} className="sidebar-project-icon" style={{ color: projectAccentVar(project.id) }} aria-hidden="true" />}
        <strong>{project.name}</strong>
        <GitBadge status={git} brief />
        <small className="sidebar-project-meta">{collapsed ? projectSummary(states) : project.sessions.length}</small>
        <span className="sidebar-row-actions">
          <button type="button" className="sidebar-project-add" aria-label={`New session in ${project.name}`}
            title={`New session in ${project.name}`} disabled={creating}
            onClick={(event) => { event.preventDefault(); event.stopPropagation(); onNewSession(event.altKey); }}>
            <Plus size={14} />
          </button>
          {onHistory && (
            <button type="button" className="glass-project-history" aria-label={`Session history for ${project.name}`}
              title="Search this project's Claude and Codex transcripts"
              onClick={(event) => { event.preventDefault(); event.stopPropagation(); onHistory(); }}>
              <HistoryIcon size={14} />
            </button>
          )}
          {onRemove && (
            <button type="button" className="glass-project-remove" aria-label={`Remove ${project.name} from Dolphin`}
              title="Remove from Dolphin (the folder stays)"
              onClick={(event) => { event.preventDefault(); event.stopPropagation(); onRemove(); }}>
              <FolderMinus size={14} />
            </button>
          )}
        </span>
      </summary>
      <div className="sidebar-sessions">
        {project.sessions.map((session, index) => {
          const { 'aria-describedby': extraDescription, ...extra } = (rowProps?.(session) ?? {}) as Record<string, unknown> & { 'aria-describedby'?: string };
          const describedBy = [glyphId(session.name), machineLabel ? `${glyphId(session.name)}-machine` : '', extraDescription ?? ''].filter(Boolean).join(' ');
          return (
          <div key={session.name} className="sidebar-session-line">
          <button type="button" data-nav-row className="sidebar-session" data-state={states[index]}
            aria-current={selectedSession === session.name ? 'true' : undefined}
            aria-label={`Open ${project.name} / ${sessionLabel(session.name)}`} aria-describedby={describedBy}
            {...extra} onClick={() => onOpen(session)}>
            {machineLabel && <span id={`${glyphId(session.name)}-machine`} hidden>{machineLabel}</span>}
            <StatusGlyph state={states[index]} id={glyphId(session.name)} />
            <span className="sidebar-session-name">{sessionLabel(session.name)}</span>
            {session.agent && <span className="sidebar-session-agent">{AGENT_NAME[session.agent]}</span>}
            <time className="sidebar-session-time" dateTime={rowTime(session) ?? undefined}>{elapsed(rowTime(session), now)}</time>
          </button>
          {(() => {
            const worktree = worktreeOf?.(session.name);
            if (!worktree) return null;
            const canArchive = Boolean(onArchive) && worktree.merged && worktree.dirty === 0;
            return (
              <span className="sidebar-worktree">
                <GitBadge status={worktree} brief />
                {canArchive && (confirming === session.name ? (
                  <>
                    <button type="button" className="sidebar-worktree-archive"
                      onClick={() => { setConfirming(null); onArchive?.(session); }}>Archive</button>
                    <button type="button" className="sidebar-worktree-keep" onClick={() => setConfirming(null)}>Keep</button>
                  </>
                ) : (
                  <button type="button" className="sidebar-worktree-archive" aria-label={`Archive worktree ${session.name}`}
                    title="Merged and clean: close its session and remove its folder. The branch stays."
                    onClick={() => setConfirming(session.name)}>Archive</button>
                ))}
              </span>
            );
          })()}
          {onTogglePin && (
            <button type="button" className="sidebar-session-pin" aria-label={`Pin ${project.name} / ${session.name}`}
              aria-pressed={pinned?.(session.name) ?? false}
              title={pinned?.(session.name) ? 'Pinned. Click to unpin.' : 'Pin to the top of the list'}
              onClick={() => onTogglePin(session)}>
              <Pin size={12} aria-hidden="true" />
            </button>
          )}
          {confirming === session.name && (() => {
            const worktree = worktreeOf?.(session.name);
            const note = worktree ? ignoredNote(worktree) : '';
            return note ? <p className="sidebar-worktree-note">{note}</p> : null;
          })()}
          </div>
          );
        })}
      </div>
    </details>
  );
}
