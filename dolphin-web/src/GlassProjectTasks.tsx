import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Plus, RefreshCw, Copy, Check } from 'lucide-react';
import { createTask, fetchTasks, updateTask } from './api';
import type { Task } from './types';

export default function GlassProjectTasks({ projectId, projectName, sessionName }: { projectId: string; projectName: string; sessionName: string }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(null), 1800);
    return () => window.clearTimeout(timer);
  }, [copied]);
  async function copyTask(task: Task) {
    try { await navigator.clipboard.writeText(task.title); setCopied(task.id); }
    catch { setError('Could not copy task text. Check clipboard permissions.'); }
  }
  const [draft, setDraft] = useState('');
  const draftInput = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const input = draftInput.current;
    if (!input) return;
    function resize() {
      if (!input) return;
      const previous = input.getBoundingClientRect().height;
      input.style.transition = 'none';
      input.style.height = '0px';
      const next = input.scrollHeight;
      input.style.height = `${previous}px`;
      void input.offsetHeight;
      input.style.transition = '';
      input.style.height = `${next}px`;
    }
    resize();
    let width = input.clientWidth;
    const observer = new ResizeObserver(() => {
      if (input.clientWidth !== width) { width = input.clientWidth; resize(); }
    });
    observer.observe(input);
    return () => observer.disconnect();
  }, [draft]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let current = true;
    async function load() {
      try {
        const result = await fetchTasks(projectId);
        if (current) { setTasks(result); setError(''); }
      } catch (e) { if (current) setError(e instanceof Error ? e.message : 'Could not load tasks.'); }
      finally { if (current) setLoading(false); }
    }
    void load();
    const timer = window.setInterval(load, 15000);
    return () => { current = false; window.clearInterval(timer); };
  }, [projectId, revision]);
  async function change(action: () => Promise<Task>, created = false) {
    setBusy(true); setError('');
    try {
      await action();
      if (created) setDraft('');
      setRevision(r => r + 1);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save task.'); }
    finally { setBusy(false); }
  }
  return <section className="glass-project-tasks" aria-label={`Tasks for ${projectName}`}>
    <header><div><strong>{projectName}</strong><small title={sessionName}>{sessionName}</small></div>
      <button aria-label="Refresh tasks" onClick={() => setRevision(r => r + 1)}><RefreshCw size={14} /></button>
    </header>
    <form onSubmit={e => { e.preventDefault(); if (draft.trim() && !busy) void change(() => createTask(projectId, draft.trim()), true); }}>
      <textarea ref={draftInput} rows={1} aria-label={`New task for ${projectName}`} placeholder="Add a task…" value={draft} onChange={e => setDraft(e.target.value)} disabled={busy} onKeyDown={e => {
        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
          e.preventDefault(); e.currentTarget.form?.requestSubmit();
        }
      }} />
      <button aria-label="Add task" disabled={busy || !draft.trim()}><Plus size={16} /></button>
    </form>
    {copied && <span role="status" className="glass-copy-feedback">Task copied</span>}
    {error && <p role="alert">{error}</p>}
    {loading ? <p role="status">Loading tasks…</p> : <div className="glass-task-list">
      {!tasks.length && !error && <p>No tasks yet for this project.</p>}
      {[false, true].map(done => {
        const group = tasks.filter(task => task.is_done === done);
        if (!group.length) return null;
        return <details key={String(done)} open={!done}><summary>{done ? 'Completed' : 'To do'} <span>{group.length}</span></summary>
          {group.map(task => <div className="glass-task-row" key={task.id}><label className="glass-task-content">
            <input type="checkbox" checked={task.is_done} disabled={busy} onChange={() => void change(() => updateTask(task.id, { is_done: !task.is_done }))} aria-label={`${task.is_done ? 'Reopen' : 'Complete'} ${task.title}`} />
            <span><span className={task.is_done ? 'glass-task-done' : ''}>{task.title}</span>{task.workflow_state && <small>{task.workflow_state.replace(/_/g, ' ')}</small>}</span>
          </label><button className="glass-task-copy" type="button" aria-label={`Copy task: ${task.title}`} title={copied === task.id ? 'Copied' : 'Copy task text'} onClick={() => void copyTask(task)}>{copied === task.id ? <Check size={14} /> : <Copy size={14} />}</button></div>)}
        </details>;
      })}
    </div>}
  </section>;
}
