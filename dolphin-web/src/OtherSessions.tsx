import { ChevronDown, SquareTerminal } from 'lucide-react';
import { sessionLabel } from './workspace/targets';
import StatusGlyph from './StatusGlyph';
import type { SessionState } from './sessionState';
import type { OtherSession } from './types';

/* tmux sessions on a machine that no project's folder holds: started in the
   home folder, a hidden folder, or a project since removed. Collapsed by
   default; one outside the folders Dolphin may open is listed but cannot open.
   Rows are the sidebar's own 28px one-line session rows. */
export default function OtherSessions({ machine, sessions, stateOf, opening, onOpen }: {
  machine: string;
  sessions: OtherSession[];
  stateOf: (session: OtherSession) => SessionState;
  /** Names being opened right now; a second click on one does nothing. */
  opening: ReadonlySet<string>;
  onOpen: (session: OtherSession) => void;
}) {
  if (!sessions.length) return null;
  const glyphId = (name: string) => `glyph-other-${machine}-${name}`.replace(/[^A-Za-z0-9_-]/g, '_');
  return (
    <details className="glass-other-sessions">
      <summary>
        <ChevronDown size={12} aria-hidden="true" />
        <SquareTerminal size={13} className="sidebar-project-icon" aria-hidden="true" />
        <strong>Other sessions</strong>
        <small>{sessions.length}</small>
      </summary>
      <div className="sidebar-sessions">
        {sessions.map((session) => (
          <div key={session.name} className="sidebar-session-line">
            <button
              type="button"
              className="sidebar-session"
              data-state={stateOf(session)}
              aria-disabled={!session.openable || opening.has(session.name) ? 'true' : undefined}
              aria-label={`Open other session ${session.name}`}
              aria-describedby={glyphId(session.name)}
              title={session.openable ? session.path : `${session.path} is outside the folders Dolphin may open.`}
              onClick={() => { if (session.openable && !opening.has(session.name)) onOpen(session); }}
            >
              <StatusGlyph state={stateOf(session)} id={glyphId(session.name)} />
              <span className="sidebar-session-name">{sessionLabel(session.name)}</span>
              <span className="sidebar-session-agent">{session.path}</span>
            </button>
          </div>
        ))}
      </div>
    </details>
  );
}
