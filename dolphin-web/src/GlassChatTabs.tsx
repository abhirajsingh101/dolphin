import { useEffect, useRef, useState, type SetStateAction } from 'react';
import { Plus, RotateCcw, X } from 'lucide-react';

type Tab = { id: string; title?: string };
const STORAGE = 'dolphin.glass.chat-tabs';
export function useChatTabs() {
  const [layout, setLayout] = useState<{ tabs: Tab[]; active: string; closed: Tab[] }>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE) || 'null');
      if (saved?.tabs?.length && saved.tabs.every((t: Tab) => typeof t.id === 'string'))
        return { tabs: saved.tabs, active: saved.tabs.some((t: Tab) => t.id === saved.active) ? saved.active : saved.tabs[0].id, closed: Array.isArray(saved.closed) ? saved.closed : [] };
    } catch { /* Storage is optional. */ }
    return { tabs: [{ id: 'initial' }], active: 'initial', closed: [] };
  });
  useEffect(() => { try { localStorage.setItem(STORAGE, JSON.stringify(layout)); } catch { /* Storage is optional. */ } }, [layout]);
  function add() {
    const id = crypto.randomUUID();
    setLayout(old => ({ ...old, tabs: [...old.tabs, { id }], active: id }));
    return id;
  }
  function close(id: string) {
    setLayout(old => {
      const index = old.tabs.findIndex(t => t.id === id);
      if (index < 0) return old;
      const tabs = old.tabs.filter(t => t.id !== id);
      if (!tabs.length) tabs.push({ id: crypto.randomUUID() });
      return { tabs, active: old.active === id ? tabs[Math.min(index, tabs.length - 1)].id : old.active, closed: [...old.closed.slice(-9), old.tabs[index]] };
    });
  }
  function reopen(id?: string) {
    setLayout(old => {
      const tab = id ? old.closed.find(item => item.id === id) : old.closed[old.closed.length - 1];
      return tab ? { tabs: [...old.tabs, tab], active: tab.id, closed: old.closed.filter(item => item.id !== tab.id) } : old;
    });
  }
  return { ...layout, add, close, reopen,
    move: (from: string, to: string) => setLayout(old => { const tabs = [...old.tabs]; const index = tabs.findIndex(tab => tab.id === from); const destination = tabs.findIndex(tab => tab.id === to); if (index < 0 || destination < 0) return old; const [tab] = tabs.splice(index, 1); tabs.splice(destination, 0, tab); return { ...old, tabs }; }),
    select: (id: string) => setLayout(old => ({ ...old, active: id })),
    rename: (id: string, title: string) => setLayout(old => ({ ...old, tabs: old.tabs.map(t => t.id === id ? { ...t, title: title.trim().slice(0, 80) || undefined } : t) })),
  };
}

// Setters capture their tab ID: a response arriving after a switch updates its
// originating tab, never whichever tab happens to be visible now.
export function useTabState<T>(id: string, initial: T, storage?: string) {
  const fallback = useRef(initial).current;
  const [values, setValues] = useState<Record<string, T>>(() => {
    try {
      const saved = storage && JSON.parse(localStorage.getItem(storage) || '{}');
      if (saved && typeof saved === 'object' && !Array.isArray(saved))
        return Object.fromEntries(Object.entries(saved).filter(([, v]) => typeof v === typeof initial)) as Record<string, T>;
    } catch { /* Storage is optional. */ }
    return {};
  });
  useEffect(() => { if (storage) try { localStorage.setItem(storage, JSON.stringify(values)); } catch { /* Storage is optional. */ } }, [values, storage]);
  function setFor(tab: string, value: SetStateAction<T>) {
    setValues(old => { const previous = old[tab] ?? fallback; const next = typeof value === 'function' ? (value as (v: T) => T)(previous) : value; return Object.is(previous, next) ? old : { ...old, [tab]: next }; });
  }
  return [values[id] ?? fallback, (value: SetStateAction<T>) => setFor(id, value), values, setFor] as const;
}
export function useTabRef<T>(id: string, initial: T) {
  const refs = useRef<Record<string, { current: T }>>({});
  return refs.current[id] ?? (refs.current[id] = { current: initial });
}

export default function GlassChatTabs({ controller, title, running, unread }: {
  controller: ReturnType<typeof useChatTabs>; title: (id: string) => string; running: (id: string) => boolean; unread: (id: string) => boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState('');
  const [name, setName] = useState('');
  useEffect(() => { root.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }, [controller.active]);
  return <div className="glass-chat-tabs" ref={root}>
    <div role="tablist" aria-label="Chat tabs" onKeyDown={event => {
      if ((event.target as HTMLElement).tagName === 'INPUT') return;
      const index = controller.tabs.findIndex(t => t.id === controller.active);
      const next = event.key === 'ArrowRight' ? (index + 1) % controller.tabs.length : event.key === 'ArrowLeft' ? (index - 1 + controller.tabs.length) % controller.tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? controller.tabs.length - 1 : -1;
      if (next >= 0) { event.preventDefault(); controller.select(controller.tabs[next].id); root.current?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus(); }
      if (event.key === 'F2') { event.preventDefault(); setEditing(controller.active); setName(title(controller.active)); }
      if (event.key === 'Delete') { event.preventDefault(); controller.close(controller.active); }
    }}>
      {controller.tabs.map(tab => <div className="glass-chat-tab" key={tab.id} data-selected={tab.id === controller.active} draggable={editing !== tab.id} onDragStart={event => { event.dataTransfer.setData('application/x-dolphin-chat-tab', tab.id); }} onDragOver={event => { if (event.dataTransfer.types.includes('application/x-dolphin-chat-tab')) event.preventDefault(); }} onDrop={event => { const from = event.dataTransfer.getData('application/x-dolphin-chat-tab'); if (from) { event.preventDefault(); controller.move(from, tab.id); } }}>
        {editing === tab.id ? <input aria-label="Tab name" autoFocus maxLength={80} value={name} onChange={e => setName(e.target.value)} onBlur={() => { controller.rename(tab.id, name); setEditing(''); }} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') setEditing(''); }} /> : <button role="tab" aria-label={title(tab.id)} aria-description={running(tab.id) ? 'Working' : unread(tab.id) ? 'New reply' : undefined} aria-selected={tab.id === controller.active} aria-controls="dolphin-chat-panel" tabIndex={tab.id === controller.active ? 0 : -1} title={`${title(tab.id)} · Double-click to rename`} onDoubleClick={() => { setEditing(tab.id); setName(title(tab.id)); }} onClick={() => controller.select(tab.id)}>
          {running(tab.id) && <i className="glass-tab-working" aria-label="Working" />}<span>{title(tab.id)}</span>{unread(tab.id) && <i className="glass-tab-unread" aria-label="New reply" />}
        </button>}
        <button aria-label={`Close tab ${title(tab.id)}`} title="Close tab — conversation and work are kept" onClick={() => controller.close(tab.id)}><X size={12} /></button>
      </div>)}
    </div>
    <button aria-label="New chat tab" title="New chat tab" onClick={controller.add}><Plus size={15} /></button>
    <button aria-label="Reopen closed chat tab" title="Reopen closed chat tab" disabled={!controller.closed.length} onClick={() => controller.reopen()}><RotateCcw size={14} /></button>
  </div>;
}
