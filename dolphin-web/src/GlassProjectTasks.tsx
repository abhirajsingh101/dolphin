import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { sessionLabel } from './workspace/targets';
import { Check, Copy, Pencil, Play, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import Disclosure from './motion/Disclosure';
import { presence, rowVariants, settleTransition } from './motion/presets';
import { useApi } from './apiContext';
import StatusGlyph from './StatusGlyph';
import { seenAt, sessionState } from './sessionState';
import { getSetting } from './settings';
import { groupTasks, launchedSession } from './taskSession';
import type { ControlCenterSession, SessionLink, Task } from './types';
import CompanionChat from './companion/CompanionChat';
import CompanionFace from './companion/CompanionFace';
import { dismissTitle, dismissedTitles, latestPlan, moodOf, sameTitle, sessionMoods, type Plan } from './companion/companionModel';

/* The selected terminal's project's todos. Each open todo can start its own
   agent session with its text as the first prompt. A todo with a session
   shows that session's state and opens it. Todos can be edited and deleted.
   The selected session's own open todos are listed first (taskSession.ts).
   The project's companion heads the tab and its chat sits at the foot: what
   it suggests shows as dashed rows to add or dismiss, and the open todo it
   would do next carries a Next up line. Nothing is saved without a click. */

export default function GlassProjectTasks({ projectId, projectName, sessionName, machine, sessions, onOpenSession, focusChat = 0 }: {
  projectId: string;
  projectName: string;
  sessionName: string;
  machine: string;
  sessions: ControlCenterSession[];
  onOpenSession: (sessionName: string) => void;
  /** Changes when the project's character is clicked; the chat takes focus. */
  focusChat?: number;
}) {
  const { createTask, deleteTask, fetchSessionLinks, fetchTasks, launchSession, updateTask } = useApi();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [links, setLinks] = useState<SessionLink[]>([]);
  const [copied, setCopied] = useState<string | null>(null);
  // Checked off or reopened, and not yet reloaded: the row shows its new state
  // at once, then leaves its group while the rows below move up.
  const [settling, setSettling] = useState<Record<string, boolean>>({});
  // Said once a check-off or a delete has saved; read out by screen readers.
  const [confirmation, setConfirmation] = useState('');
  useEffect(() => {
    if (!confirmation) return;
    const timer = window.setTimeout(() => setConfirmation(''), 1800);
    return () => window.clearTimeout(timer);
  }, [confirmation]);
  const [editing, setEditing] = useState<{ id: string; title: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [editError, setEditError] = useState('');
  // A launch's own message; load and the poll never clear it.
  const [launchMessage, setLaunchMessage] = useState('');
  // Tasks whose launch is in flight or whose link has not reloaded yet.
  const launching = useRef(new Set<string>());
  const [, bump] = useState(0);
  useEffect(() => { setConfirmDelete(null); }, [tasks]);
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
        const [result, linked] = await Promise.all([fetchTasks(projectId), fetchSessionLinks(projectId).catch(() => [])]);
        if (current) {
          for (const id of [...launching.current]) {
            if (linked.some((link) => link.task_id === id && !link.archived_at)) launching.current.delete(id);
          }
          setTasks(result); setLinks(linked); setError('');
          setSettling(old => Object.keys(old).length ? {} : old);
        }
      } catch (e) { if (current) setError(e instanceof Error ? e.message : 'Could not load tasks.'); }
      finally { if (current) setLoading(false); }
    }
    void load();
    const timer = window.setInterval(load, 15000);
    return () => { current = false; window.clearInterval(timer); };
  }, [projectId, revision]);
  async function change(action: () => Promise<unknown>, created = false, saved = '') {
    setBusy(true); setError('');
    try {
      await action();
      if (created) setDraft('');
      if (saved) setConfirmation(saved);
      setRevision(r => r + 1);
    } catch (e) { setSettling({}); setError(e instanceof Error ? e.message : 'Could not save task.'); }
    finally { setBusy(false); }
  }
  function toggleDone(task: Task) {
    // What the row shows, not the server's last word: a second click can land
    // while the reload after the first save is still in flight.
    const done = !(settling[task.id] ?? task.is_done);
    setSettling(old => ({ ...old, [task.id]: done }));
    void change(() => updateTask(task.id, { is_done: done }), false, done ? 'Task completed' : 'Task reopened');
  }
  async function start(task: Task) {
    const preferred = getSetting('newSession.defaultAgent');
    const mode = preferred === 'codex' ? 'codex' : 'claude';
    if (launching.current.has(task.id)) return;
    launching.current.add(task.id); bump(n => n + 1);
    setLaunchMessage('');
    try {
      const launched = await launchSession(projectId, { mode, task_id: task.id });
      setRevision(r => r + 1);
      onOpenSession(launched.session.name);
      if (launched.warning) setLaunchMessage(launched.warning);
    } catch (e) {
      launching.current.delete(task.id);
      setLaunchMessage(e instanceof Error ? e.message : 'Could not start a session.');
    } finally { bump(n => n + 1); }
  }
  function saveEdit(task: Task) {
    if (!editing || editing.id !== task.id) return;
    const title = editing.title.trim();
    if (!title) { setEditError('A task needs a title.'); return; }
    setEditing(null); setEditError('');
    if (title !== task.title) void change(() => updateTask(task.id, { title }));
  }
  const sessionFor = (task: Task) => launchedSession(task, links, sessions);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [dismissed, setDismissed] = useState(() => dismissedTitles(projectId));
  const suggestions = (plan?.suggestions ?? []).filter((s) => !dismissed.some((t) => sameTitle(t, s.title)) && !tasks.some((t) => sameTitle(t.title, s.title)));
  const next = plan?.next && tasks.some((t) => t.id === plan.next?.task_id && !t.is_done) ? plan.next : null;
  const { mood, label } = moodOf(sessionMoods(sessions, machine, projectId), Date.now());
  function dismiss(title: string) { dismissTitle(projectId, title); setDismissed(dismissedTitles(projectId)); }
  return <section className="glass-project-tasks" aria-label={`Tasks for ${projectName}`}>
    <header><CompanionFace seed={projectId} mood={mood} size={30} follow={false} /><div><strong>{projectName}</strong><small title={sessionLabel(sessionName)}>{label}</small></div>
      <button aria-label="Refresh tasks" onClick={() => setRevision(r => r + 1)}><RefreshCw size={14} /></button>
    </header>
    <form onSubmit={e => { e.preventDefault(); if (draft.trim() && !busy) void change(() => createTask(projectId, draft.trim(), '', { session_name: sessionName }), true); }}>
      <textarea ref={draftInput} rows={1} aria-label={`New task for ${projectName}`} placeholder="Add a task…" value={draft} onChange={e => setDraft(e.target.value)} disabled={busy} onKeyDown={e => {
        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
          e.preventDefault(); e.currentTarget.form?.requestSubmit();
        }
      }} />
      <button aria-label="Add task" disabled={busy || !draft.trim()}><Plus size={16} /></button>
    </form>
    {copied && <span role="status" className="glass-copy-feedback">Task copied</span>}
    {/* The row's own change is the visible confirmation; this says it aloud. */}
    <span role="status" className="dt-sr-only">{confirmation}</span>
    {error && <p role="alert">{error}</p>}
    {launchMessage && <p role="alert" className="glass-task-message">{launchMessage}<button type="button" aria-label="Dismiss message" onClick={() => setLaunchMessage('')}>×</button></p>}
    {loading ? <p role="status">Loading tasks…</p> : <motion.div className="glass-task-list" layoutScroll>
      {!tasks.length && !error && !suggestions.length && <p>No tasks yet for this project.</p>}
      {suggestions.length > 0 && <Disclosure key="suggested" defaultOpen layout bodyClassName="glass-task-group" summary={<>Suggested <span>{suggestions.length}</span></>}>
        <AnimatePresence initial={false} mode="popLayout">
        {suggestions.map((s) => <motion.div className="glass-task-item" key={`suggested:${s.title}`} layout="position" transition={settleTransition} variants={rowVariants} {...presence}>
          <div className="glass-task-row glass-task-suggested">
            <span className="glass-task-content"><span><span>{s.title}</span><small>{s.why}</small></span></span>
            <div className="glass-task-actions">
              <button type="button" className="glass-task-start" disabled={busy} aria-label={`Add ${s.title}`} title="Add to tasks" onClick={() => void change(() => createTask(projectId, s.title, s.why, { session_name: sessionName }), false, 'Task added')}><Plus size={14} /></button>
              <button type="button" className="glass-task-copy" aria-label={`Dismiss ${s.title}`} title="Dismiss" onClick={() => dismiss(s.title)}><X size={14} /></button>
            </div>
          </div>
        </motion.div>)}
        </AnimatePresence>
      </Disclosure>}
      {groupTasks(tasks, links, sessions, sessionName).map(group => {
        return <Disclosure key={group.key} defaultOpen={group.key !== 'done'} layout className={group.key === 'session' ? 'glass-task-session-group' : undefined} bodyClassName="glass-task-group" summary={<>{group.title} <span>{group.tasks.length}</span></>}>
          <AnimatePresence initial={false} mode="popLayout">
          {group.tasks.map(task => {
            const session = sessionFor(task);
            const checked = settling[task.id] ?? task.is_done;
            const row = (content: ReactNode) => <motion.div className="glass-task-item" key={task.id} layout="position" transition={settleTransition} variants={rowVariants} {...presence}>{content}</motion.div>;
            if (editing?.id === task.id) {
              return row(<form className="glass-task-row glass-task-edit" onSubmit={e => {
                e.preventDefault();
                saveEdit(task);
              }}>
                <input autoFocus aria-label="Task title" value={editing.title} onChange={e => { setEditError(''); setEditing({ id: task.id, title: e.target.value }); }}
                  onBlur={() => { if (editing.title.trim()) saveEdit(task); }}
                  onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); setEditError(''); setEditing(null); } }} />
                {editError && <small role="alert">{editError}</small>}
              </form>);
            }
            return row(<div className="glass-task-row" data-settling={task.id in settling || undefined}>
              <label className="glass-task-content">
                <input type="checkbox" checked={checked} disabled={busy} onChange={() => toggleDone(task)} aria-label={`${checked ? 'Reopen' : 'Complete'} ${task.title}`} />
                <span><span className={task.is_done ? 'glass-task-done' : ''}>{task.title}</span>{task.workflow_state && <small>{task.workflow_state.replace(/_/g, ' ')}</small>}{next?.task_id === task.id && <small className="glass-task-next">Next up{next.reason ? ` · ${next.reason}` : ''}</small>}</span>
              </label>
              {session ? (
                <button className="glass-task-session" type="button" aria-label={`Open session ${session.name} for ${task.title}`} title={`Open ${session.name}`} onClick={() => onOpenSession(session.name)}>
                  <StatusGlyph state={sessionState(session, seenAt(machine, projectId, session.name))} />
                </button>
              ) : null}
              <div className={`glass-task-actions${confirmDelete === task.id ? ' is-confirming' : ''}`}>
              {!session && !task.is_done && (
                <button className="glass-task-start" type="button" disabled={busy || launching.current.has(task.id)} aria-label={`Start ${task.title} in a new session`} title="Start an agent with this todo as its prompt" onClick={() => void start(task)}><Play size={14} /></button>
              )}
              <button className="glass-task-copy" type="button" aria-label={`Edit ${task.title}`} title="Edit" onClick={() => setEditing({ id: task.id, title: task.title })}><Pencil size={14} /></button>
              {confirmDelete === task.id ? <>
                <button className="glass-task-delete" type="button" aria-label={`Confirm delete ${task.title}`} onClick={() => { setConfirmDelete(null); void change(() => deleteTask(task.id), false, 'Task deleted'); }}>Delete</button>
                <button className="glass-task-copy" type="button" onClick={() => setConfirmDelete(null)}>Keep</button>
              </> : <button className="glass-task-copy" type="button" aria-label={`Delete ${task.title}`} title="Delete" onClick={() => setConfirmDelete(task.id)}><Trash2 size={14} /></button>}
              <button className="glass-task-copy" type="button" aria-label={`Copy task: ${task.title}`} title={copied === task.id ? 'Copied' : 'Copy task text'} onClick={() => void copyTask(task)}>{copied === task.id ? <Check size={14} /> : <Copy size={14} />}</button>
              </div>
            </div>);
          })}
          </AnimatePresence>
        </Disclosure>;
      })}
    </motion.div>}
    <CompanionChat projectId={projectId} projectName={projectName} focusSignal={focusChat} onMessages={(messages) => { setPlan(latestPlan(messages)); setRevision(r => r + 1); }} />
  </section>;
}
