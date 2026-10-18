import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Lightbulb } from 'lucide-react';
import { DolphinApiError } from './api';
import { useApi } from './apiContext';
import type { SkillSuggestion, SkillSuggestions as Suggestions } from './types';
import {
  POLL_MS, SKILL_SUGGESTIONS_CHANGED, agentLabel, formatInstalls, headline, kindLabel, parseSuggestions, safeLink, shownSuggestions,
} from './skillSuggestionsModel';
import './composerNotice.css';
import './skillSuggestions.css';

/* Dolphin Desktop: the one skill a day that would most improve the user's recent work, as one
   quiet line above the composer. This computer's helper picks it once a day. Dolphin never installs anything: each card has the page to
   read and the command to copy and run yourself. Nothing here takes focus. */

const COPIED_MS = 1600;
// A window that keeps gaining focus asks at most this often.
const FOCUS_MIN_MS = 60_000;

export default function SkillSuggestions() {
  const api = useApi();
  const [data, setData] = useState<Suggestions | null>(null);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const toggle = useRef<HTMLButtonElement>(null);
  const listId = useId();

  useEffect(() => {
    let stopped = false;
    let asked = 0;
    let later: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      asked = Date.now();
      try {
        const next = parseSuggestions(await api.fetchSkillSuggestions());
        if (!stopped) setData(next);
      } catch (error) {
        // An older helper has no such endpoint: show nothing, say nothing.
        // Anything else keeps what is already showing until the next look.
        if (!stopped && error instanceof DolphinApiError && error.status === 404) setData(null);
      }
    };
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    const focused = () => { if (Date.now() - asked >= FOCUS_MIN_MS) void load(); };
    // Settings turned it on or asked for a fresh look, which finishes a little later.
    const changed = () => { void load(); clearTimeout(later); later = setTimeout(() => void load(), 30_000); };
    window.addEventListener('focus', focused);
    window.addEventListener(SKILL_SUGGESTIONS_CHANGED, changed);
    return () => {
      stopped = true;
      clearInterval(timer);
      clearTimeout(later);
      window.removeEventListener('focus', focused);
      window.removeEventListener(SKILL_SUGGESTIONS_CHANGED, changed);
    };
  }, [api]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  const items = shownSuggestions(data, dismissed);
  if (!items.length && !message) return null;

  const copy = async (row: SkillSuggestion) => {
    setMessage('');
    try {
      await navigator.clipboard.writeText(row.install);
      setCopied(row.key);
    } catch {
      setMessage(`Couldn't copy the install command for ${row.name}. Select it and copy it yourself.`);
    }
  };

  const dismiss = async (row: SkillSuggestion, card: HTMLElement | null) => {
    // Focus was on this card's button; keep it in the line rather than lose it.
    if (card?.contains(document.activeElement)) toggle.current?.focus({ preventScroll: true });
    setMessage('');
    setDismissed((all) => new Set(all).add(row.key));
    try {
      await api.dismissSkillSuggestion(row.key);
    } catch {
      setDismissed((all) => { const next = new Set(all); next.delete(row.key); return next; });
      setMessage(`Couldn't hide ${row.name}. Try Not Interested again.`);
    }
  };

  return (
    <section className="signals-tray skill-suggestions" aria-label="Skill suggestions">
      {items.length > 0 && (
        <button ref={toggle} type="button" className="skill-suggestions-toggle" aria-expanded={open} aria-controls={listId} onClick={() => setOpen((value) => !value)}>
          <Lightbulb size={15} aria-hidden="true" />
          <span className="skill-suggestions-headline">{headline(items)}</span>
          <span className="skill-suggestions-hint">
            {open ? 'Hide' : 'Show'}
            {open ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
          </span>
        </button>
      )}
      {open && items.length > 0 && (
        <ul id={listId} className="skill-suggestions-list">
          {items.map((row) => <Card key={row.key} row={row} copied={copied === row.key} onCopy={() => void copy(row)} onDismiss={(card) => void dismiss(row, card)} />)}
        </ul>
      )}
      <span className="skill-sr" role="status">{copied ? `Copied the install command for ${items.find((row) => row.key === copied)?.name ?? 'it'}.` : ''}</span>
      {message && <p className="signals-status" role="alert">{message}</p>}
    </section>
  );
}

function Card({ row, copied, onCopy, onDismiss }: { row: SkillSuggestion; copied: boolean; onCopy: () => void; onDismiss: (card: HTMLElement | null) => void }) {
  const card = useRef<HTMLLIElement>(null);
  const link = safeLink(row.url);
  const agent = agentLabel(row.agent);
  const installs = formatInstalls(row.installs);
  return (
    <li ref={card} className="skill-card">
      <div className="skill-card-head">
        <strong>{row.name}</strong>
        <span className="skill-chip">{kindLabel(row.kind)}</span>
        {agent && <span className="skill-chip">{agent}</span>}
        {installs && <span className="skill-installs">{installs}</span>}
      </div>
      {(row.reason || row.project) && (
        <p className="skill-reason">
          {row.reason}
          {row.project && <span className="skill-project">{row.reason ? ' · ' : ''}for {row.project}</span>}
        </p>
      )}
      <div className="skill-card-foot">
        {row.install && <code className="skill-command">{row.install}</code>}
        <div className="signals-actions">
          {link && <a className="skill-open" href={link} target="_blank" rel="noopener noreferrer" title={link} aria-label={`Open ${row.name}`}>Open</a>}
          {row.install && (
            <button type="button" className="signals-primary" aria-label={`Copy Install Command for ${row.name}`} onClick={onCopy}>
              {copied ? 'Copied' : 'Copy Install Command'}
            </button>
          )}
          <button type="button" aria-label={`Not Interested in ${row.name}`} onClick={() => onDismiss(card.current)}>Not Interested</button>
        </div>
      </div>
    </li>
  );
}
