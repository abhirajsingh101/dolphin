import { describe, expect, it } from 'vitest';
import { groupTasks, launchedSession, taskSession } from './taskSession';
import type { SessionLink, Task } from './types';

const task = (id: string, extra: Partial<Task> = {}) => ({ id, title: id, is_done: false, created_in_session: null, ...extra }) as Task;
const link = (session_name: string, task_id: string, extra: Partial<SessionLink> = {}) =>
  ({ session_name, task_id, created_at: '2026-11-13T00:00:00Z', archived_at: null, ...extra }) as SessionLink;
const live = (...names: string[]) => names.map((name) => ({ name }));

describe('taskSession', () => {
  it('is the session the todo was added in', () => {
    expect(taskSession(task('a', { created_in_session: 'api' }), [], live('api'))).toBe('api');
    expect(taskSession(task('a'), [], live('api'))).toBeNull();
  });

  it('is the session the todo launched, not the one it was added in', () => {
    const todo = task('a', { created_in_session: 'api' });
    expect(taskSession(todo, [link('run-1', 'a')], live('api', 'run-1'))).toBe('run-1');
  });

  it('goes back to where it was added once the launched session is closed or archived', () => {
    const todo = task('a', { created_in_session: 'api' });
    expect(taskSession(todo, [link('run-1', 'a')], live('api'))).toBe('api');
    expect(taskSession(todo, [link('run-1', 'a', { archived_at: '2026-11-13T01:00:00Z' })], live('api', 'run-1'))).toBe('api');
  });

  it('takes the newest launched session that still runs', () => {
    const links = [link('old', 'a', { created_at: '2026-11-12T00:00:00Z' }), link('new', 'a'), link('gone', 'a', { created_at: '2026-11-14T00:00:00Z' })];
    expect(launchedSession(task('a'), links, live('old', 'new'))?.name).toBe('new');
  });
});

describe('groupTasks', () => {
  const tasks = [
    task('here', { created_in_session: 'api' }),
    task('elsewhere', { created_in_session: 'web' }),
    task('plain'),
    task('launched', { created_in_session: 'web' }),
    task('finished', { created_in_session: 'api', is_done: true }),
  ];
  const links = [link('api', 'launched')];

  it('lists the selected session’s open todos first, then the rest, then completed', () => {
    const groups = groupTasks(tasks, links, live('api', 'web'), 'api');
    expect(groups.map((group) => [group.key, group.tasks.map((item) => item.id)])).toEqual([
      ['session', ['here', 'launched']],
      ['todo', ['elsewhere', 'plain']],
      ['done', ['finished']],
    ]);
  });

  it('leaves out a group with nothing in it', () => {
    expect(groupTasks(tasks, links, live('api', 'web'), 'other').map((group) => group.key)).toEqual(['todo', 'done']);
  });
});
