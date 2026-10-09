import { useEffect, useMemo, useRef, useState } from 'react';

import {
  moveSelection,
  searchPalette,
  type PaletteItem,
} from './commandPaletteModel';
import './commandPalette.css';

const LISTBOX_ID = 'cp-listbox';

function optionId(item: PaletteItem): string {
  return `cp-option-${item.id}`;
}

/** Focus `el` if it still exists in the document and can accept focus.
 * Never throws — a stale or unmountable element is silently ignored. */
function restoreFocus(el: HTMLElement | null): void {
  if (!el || !el.isConnected) return;
  if (typeof el.focus !== 'function') return;
  try {
    el.focus();
  } catch {
    // Element may have become unfocusable since it was captured — ignore.
  }
}

export default function CommandPalette({
  items,
  onSelect,
  open,
  onClose,
}: {
  items: PaletteItem[];
  onSelect: (item: PaletteItem) => void;
  open: boolean;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  const groups = useMemo(() => searchPalette(items, query), [items, query]);
  const flat = useMemo(() => groups.flatMap((group) => group.items), [groups]);
  const activeItem = flat[cursor];

  useEffect(() => {
    if (!open) return;
    previouslyFocusedRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setQuery('');
    setCursor(0);
    inputRef.current?.focus();

    // Cleanup runs on every path that flips `open` back to false — Escape,
    // a scrim click, selecting an item, AND a parent toggling the `open`
    // prop directly (e.g. Cmd/Ctrl+K again). That last path bypasses
    // closeWithoutSelection() entirely, so restoring focus here (rather
    // than only inside closeWithoutSelection) is what keeps ALL dismissal
    // paths landing back on the element that had focus before the palette
    // opened. `choose()` deliberately nulls the ref first, so this is a
    // no-op after a selection — the navigation target keeps focus.
    return () => {
      const target = previouslyFocusedRef.current;
      previouslyFocusedRef.current = null;
      restoreFocus(target);
    };
  }, [open]);

  useEffect(() => setCursor(0), [query]);

  if (!open) return null;

  /** Close the palette without a selection (Escape, scrim click) — hand
   * focus back to whatever had it before the palette opened. */
  function closeWithoutSelection() {
    const target = previouslyFocusedRef.current;
    previouslyFocusedRef.current = null;
    onClose();
    restoreFocus(target);
  }

  /** Close the palette because an item was chosen — the navigation target
   * takes focus naturally, so the previous element is deliberately not
   * restored here. */
  function choose(item: PaletteItem) {
    previouslyFocusedRef.current = null;
    onSelect(item);
    onClose();
  }

  function cycleFocus(shiftKey: boolean) {
    const panel = panelRef.current;
    if (!panel) return;
    const focusables = Array.from(
      panel.querySelectorAll<HTMLElement>('input, button:not(:disabled)'),
    );
    if (focusables.length === 0) return;
    const activeIndex = focusables.indexOf(document.activeElement as HTMLElement);
    const delta = shiftKey ? -1 : 1;
    const nextIndex =
      ((activeIndex === -1 ? 0 : activeIndex) + delta + focusables.length) %
      focusables.length;
    focusables[nextIndex]?.focus();
  }

  return (
    <div
      className="cp-scrim"
      onClick={closeWithoutSelection}
      role="presentation"
    >
      <div
        aria-label="Command palette"
        aria-modal="true"
        className="cp-panel"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Tab') {
            event.preventDefault();
            cycleFocus(event.shiftKey);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            closeWithoutSelection();
          } else if (event.key === 'ArrowDown') {
            event.preventDefault();
            setCursor(moveSelection(flat.length, cursor, 1));
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setCursor(moveSelection(flat.length, cursor, -1));
          } else if (event.key === 'Enter' && flat[cursor]) {
            event.preventDefault();
            choose(flat[cursor]);
          }
        }}
        ref={panelRef}
        role="dialog"
      >
        <div className="cp-field">
          <input
            aria-activedescendant={activeItem ? optionId(activeItem) : undefined}
            aria-controls={LISTBOX_ID}
            aria-expanded="true"
            aria-haspopup="listbox"
            aria-label="Search tasks, projects and sessions"
            autoComplete="off"
            className="dt-input"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search or jump to…"
            ref={inputRef}
            role="combobox"
            value={query}
          />
        </div>

        <div className="cp-results" id={LISTBOX_ID} role="listbox">
          {groups.length === 0 ? (
            <p className="cp-none">No matches for “{query}”.</p>
          ) : (
            groups.map((group) => (
              <div key={group.kind}>
                <p className="cp-heading">{group.heading}</p>
                {group.items.map((item) => {
                  const index = flat.indexOf(item);
                  return (
                    <button
                      aria-selected={index === cursor}
                      className={index === cursor ? 'cp-row is-active' : 'cp-row'}
                      id={optionId(item)}
                      key={item.id}
                      onClick={() => choose(item)}
                      onMouseEnter={() => setCursor(index)}
                      role="option"
                      type="button"
                    >
                      <span>{item.label}</span>
                      {item.hint ? <em>{item.hint}</em> : null}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="cp-foot">
          <span><kbd className="dt-kbd">↑↓</kbd> navigate</span>
          <span><kbd className="dt-kbd">↵</kbd> open</span>
          <span><kbd className="dt-kbd">esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}
