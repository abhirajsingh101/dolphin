import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';

import { clampActive, findCountLabel, findMatches, findSegments, stepMatch } from './find';

const DEBOUNCE_MS = 120;

/** Find in a session's history: a snapshot over the terminal, matches marked. */
export default function TerminalFind({ load, onClose, focusToken = 0 }: { load: () => Promise<string>; onClose: () => void; focusToken?: number }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [typed, setTyped] = useState('');
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [activeRaw, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const body = useRef<HTMLPreElement>(null);

  useEffect(() => {
    input.current?.focus();
    setText(null);
    setError('');
    let current = true;
    load().then(
      (content) => { if (current) setText(content); },
      () => { if (current) setError("Couldn't read this session's history. Close find and try again."); },
    );
    return () => { current = false; };
  }, [load]);

  // Find pressed again while open: back to the input, text selected.
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [focusToken]);

  // Searching 10,000 lines per keystroke would stutter; wait for a pause.
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(typed), DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [typed]);

  const matches = useMemo(() => (text === null ? [] : findMatches(text, query, { caseSensitive })), [text, query, caseSensitive]);
  const segments = useMemo(() => (text === null ? [] : findSegments(text, matches)), [text, matches]);
  const active = clampActive(activeRaw, matches.length);
  useEffect(() => setActive(0), [query, caseSensitive, text]);
  useEffect(() => {
    body.current?.querySelector('mark[data-active="true"]')?.scrollIntoView?.({ block: 'center' });
  }, [active, matches]);

  const step = (direction: 1 | -1) => setActive(stepMatch(active, matches.length, direction));

  return (
    <div className="glass-find" role="dialog" aria-label="Find in terminal history"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation(); // Escape here must not also leave fullscreen.
        onClose();
      }}>
      <div className="glass-find-bar">
        <input ref={input} aria-label="Find" placeholder="Find in history" value={typed}
          onChange={(event) => setTyped(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            step(event.shiftKey ? -1 : 1);
          }} />
        <span className="glass-find-count" role="status" aria-live="polite">
          {text === null && !error ? 'Loading…' : findCountLabel(active, matches.length, query)}
        </span>
        <button type="button" aria-label="Match case" aria-pressed={caseSensitive} title="Match case"
          onClick={() => setCaseSensitive((value) => !value)}>Aa</button>
        <button type="button" aria-label="Previous match" title="Previous match (Shift+Enter)" disabled={matches.length === 0}
          onClick={() => step(-1)}><ChevronUp size={14} aria-hidden="true" /></button>
        <button type="button" aria-label="Next match" title="Next match (Enter)" disabled={matches.length === 0}
          onClick={() => step(1)}><ChevronDown size={14} aria-hidden="true" /></button>
        <button type="button" aria-label="Close find" title="Close (Esc)" onClick={onClose}><X size={14} aria-hidden="true" /></button>
      </div>
      {error
        ? <p className="glass-find-error" role="alert">{error}</p>
        : <pre ref={body} className="glass-find-text" tabIndex={0}>
            {segments.map((segment, index) => segment.match === null
              ? segment.text
              : <mark key={index} data-active={segment.match === active}>{segment.text}</mark>)}
          </pre>}
    </div>
  );
}
