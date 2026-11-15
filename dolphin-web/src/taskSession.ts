import type { SessionLink, Task } from './types';

/* Which tmux session a todo belongs to, and the sidebar's groups from that.

   A todo belongs to the session it launched while that session runs.
   Otherwise it belongs to the session that was selected when it was added.
   A todo whose session is closed, or that never had one, lists under To do. */

type Live = { name: string };

/** The newest session a todo launched that still runs. */
export function launchedSession<S extends Live>(task: Task, links: SessionLink[], sessions: S[]): S | null {
  const mine = links.filter((link) => link.task_id === task.id && !link.archived_at)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.session_name.localeCompare(a.session_name));
  for (const link of mine) {
    const session = sessions.find((item) => item.name === link.session_name);
    if (session) return session;
  }
  return null;
}

export function taskSession(task: Task, links: SessionLink[], sessions: Live[]): string | null {
  return launchedSession(task, links, sessions)?.name ?? task.created_in_session ?? null;
}

export type TaskGroup = { key: 'session' | 'todo' | 'done'; title: string; tasks: Task[] };

/** The selected session's open todos, then the other open ones, then completed. Empty groups are left out. */
export function groupTasks(tasks: Task[], links: SessionLink[], sessions: Live[], sessionName: string): TaskGroup[] {
  const open = tasks.filter((task) => !task.is_done);
  const here = new Set(open.filter((task) => taskSession(task, links, sessions) === sessionName).map((task) => task.id));
  const groups: TaskGroup[] = [
    { key: 'session', title: 'This session', tasks: open.filter((task) => here.has(task.id)) },
    { key: 'todo', title: 'To do', tasks: open.filter((task) => !here.has(task.id)) },
    { key: 'done', title: 'Completed', tasks: tasks.filter((task) => task.is_done) },
  ];
  return groups.filter((group) => group.tasks.length);
}
