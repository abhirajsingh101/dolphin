import { useEffect, useRef, useState } from 'react';
import { RotateCcw, X } from 'lucide-react';
import { useApi } from './apiContext';
import { highlight, timeAgo } from './historyModel';
import { AGENT_NAMES } from './usageModel';
import { panelError, useModalPanel } from './useModalPanel';
import type { HistoryItem } from './types';
import './workflow.css';

/* A project's Claude Code and Codex transcripts on its machine, newest first,
   searchable. "Resume" starts the agent on that transcript in a new tmux
   session, in the folder it was recorded in. */

const RECENT_ONLY = 'Only recent sessions are shown.';

export default function HistoryPanel({ projectId, projectName, onClose, onResume }: {
  projectId: string;
  projectName: string;
  onClose: () => void;
  onResume: (item: HistoryItem) => void;
}) {
  const { searchHistory } = useApi();
  // Read through a ref: a client that is rebuilt each render must not restart the search.
  const search = useRef(searchHistory);
  search.current = searchHistory;
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<HistoryItem[] | null>(null);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useModalPanel(panel, onClose, { focus: input });
  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      search.current(projectId, query, controller.signal)
        .then((found) => { if (!controller.signal.aborted) { setItems(found); setError(''); } })
        .catch((reason) => { if (!controller.signal.aborted) setError(panelError(reason)); });
    }, 250);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [projectId, query]);
  const now = new Date();
  return (
    <div className="workflow-scrim" role="presentation" onClick={onClose}>
      <div ref={panel} tabIndex={-1} className="workflow-panel" role="dialog" aria-modal="true" aria-label={`History of ${projectName}`}
        onClick={(event) => event.stopPropagation()}>
        <header className="workflow-header">
          <h2>History of {projectName}</h2>
          <small>Claude Code and Codex transcripts on this machine</small>
          <button type="button" className="dt-btn dt-btn--ghost" aria-label="Close" onClick={onClose}><X size={16} aria-hidden="true" /></button>
        </header>
        <div className="workflow-body">
          <input ref={input} type="search" className="workflow-search" aria-label="Search transcripts" placeholder="Search transcripts…" value={query} onChange={(event) => setQuery(event.target.value)} />
          {items === null && !error && <p role="status">Reading transcripts…</p>}
          {error && <p role="alert">{error}</p>}
          {items?.length === 0 && <p>{query.trim() ? `No recent transcript mentions “${query.trim()}”.` : 'No transcripts for this project yet.'} {RECENT_ONLY}</p>}
          {!!items?.length && (
            <ul className="workflow-list">
              {items.map((item) => (
                <li key={`${item.agent}:${item.id}`}>
                  <span>
                    <strong>{item.title}</strong>
                    <small>{AGENT_NAMES[item.agent]} · {timeAgo(item.updated_at, now)} · {item.message_count} messages</small>
                    {item.snippets.map((snippet, index) => (
                      <small key={index}>{highlight(snippet, query).map((part, at) => part.match ? <mark key={at}>{part.text}</mark> : <span key={at}>{part.text}</span>)}</small>
                    ))}
                  </span>
                  <button type="button" className="machine-action" aria-label={`Resume ${item.title}`} title="Resume in new session" onClick={() => onResume(item)}>
                    <RotateCcw size={13} aria-hidden="true" /> Resume in new session
                  </button>
                </li>
              ))}
            </ul>
          )}
          {!!items?.length && items.length < 10 && <p className="workflow-note">{RECENT_ONLY}</p>}
        </div>
      </div>
    </div>
  );
}
