import { useRef, useState } from 'react';
import { Check, ChevronDown, MessageSquare, Plus, Search, Trash2, X } from 'lucide-react';
import { request } from './api';

type Thread = { id: string; title: string };
export default function GlassConversations({ threads, selected, disabled, protectedIds = [], onSelect, onDeleted }: {
  threads: Thread[]; selected: string; disabled: boolean; protectedIds?: string[];
  onSelect: (id: string) => void; onDeleted: (id: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [confirm, setConfirm] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');
  const title = threads.find(t => t.id === selected)?.title || 'New conversation';
  function select(id: string) { onSelect(id); dialog.current?.close(); }
  async function remove(id: string) {
    setDeleting(true); setError('');
    try {
      await request<void>(`/api/chief/threads/${encodeURIComponent(id)}`, { method: 'DELETE' });
      onDeleted(id); setConfirm(null);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not delete conversation.'); }
    finally { setDeleting(false); }
  }
  const filtered = threads.filter(t => t.title.toLowerCase().includes(query.toLowerCase()));
  return <>
    <button className="glass-conversation-trigger" aria-label="Choose conversation" aria-haspopup="dialog" disabled={disabled} title={`Conversation history · ${title}`} onClick={() => { setQuery(''); setConfirm(null); setError(''); dialog.current?.showModal(); search.current?.focus(); }}>
      <MessageSquare size={15} /><span>{title}</span><ChevronDown size={14} />
    </button>
    <dialog ref={dialog} className="glass-conversation-dialog" aria-labelledby="glass-conversation-heading" onClick={event => { if (event.target === event.currentTarget) dialog.current?.close(); }}>
      <div className="glass-conversation-picker">
        <header><div><h2 id="glass-conversation-heading">Conversations</h2><p>Pick up where you left off</p></div><button aria-label="Close conversations" onClick={() => dialog.current?.close()}><X size={18} /></button></header>
        <label className="glass-conversation-search"><Search size={17} /><input ref={search} aria-label="Search conversations" placeholder="Search your conversations…" value={query} onChange={e => setQuery(e.target.value)} /></label>
        <button className="glass-conversation-new" disabled={disabled || deleting} onClick={() => select('')}><Plus size={16} />New conversation</button>
        {error && <p role="alert">{error}</p>}
        <div className="glass-conversation-list">
          {!filtered.length && <p className="glass-conversation-empty">{query ? 'No matching conversations.' : 'Your conversations will appear here.'}</p>}
          {filtered.map(t => <div className="glass-conversation-row" key={t.id} data-selected={selected === t.id}>
            {confirm === t.id ? <div className="glass-conversation-confirm"><span>Delete “{t.title}”? This cannot be undone.</span><div><button disabled={deleting} onClick={() => setConfirm(null)}>Cancel</button><button className="glass-delete-confirm" disabled={deleting} onClick={() => void remove(t.id)}>{deleting ? 'Deleting…' : 'Delete conversation'}</button></div></div> : <>
              <button className="glass-conversation-choice" disabled={disabled || deleting} aria-pressed={selected === t.id} onClick={() => select(t.id)}><MessageSquare size={16} /><span>{t.title}</span>{selected === t.id && <Check size={15} />}</button>
              <button className="glass-conversation-delete" aria-label={`Delete conversation: ${t.title}`} title="Delete conversation" disabled={disabled || deleting || protectedIds.includes(t.id)} onClick={() => setConfirm(t.id)}><Trash2 size={15} /></button>
            </>}
          </div>)}
        </div>
        <footer>{filtered.length} conversation{filtered.length === 1 ? '' : 's'}<span>Esc to close</span></footer>
      </div>
    </dialog>
  </>;
}
