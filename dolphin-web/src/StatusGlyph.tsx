import { STATE_LABEL, type SessionState } from './sessionState';
import './statusGlyph.css';

/** The only status indicator (spec "Session agent state"). The shape tells the
    states apart as well as the colour: a turning arc (working), a solid dot
    (finished, not seen yet), a cross (error), a hollow ring (idle). It never
    pulses; the arc turns only in Dolphin Desktop (desktop/motion.css), and
    never under reduced motion. */
export default function StatusGlyph({ state, id }: { state: SessionState; id?: string }) {
  return (
    <span className="status-glyph" data-state={state} role="img" aria-label={STATE_LABEL[state]} title={STATE_LABEL[state]} id={id}>
      <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" focusable="false">
        {state === 'working' && <path d="M6 1.5a4.5 4.5 0 1 1-4.5 4.5" />}
        {state === 'error' && <path d="M3 3l6 6M9 3l-6 6" />}
        {(state === 'unread' || state === 'idle') && <circle cx="6" cy="6" r="3.5" />}
      </svg>
    </span>
  );
}
