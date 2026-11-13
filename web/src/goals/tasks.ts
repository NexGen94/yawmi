// The tasks of a goal (design 13.1, ruling 2): the owner's own small list, `GET`/`POST
// /v1/goals/{ref}/tasks`. Ticking one is an event (`goal_task_set`) in the outbox, so it works
// without a connection and the counter moves before any answer; adding a task is a request that
// needs a connection. The server's tasks with the outbox laid over them are what the page shows.

import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';

import { api } from '../api/client';
import { unwrap } from '../api/unwrap';
import { setGoalTask } from '../data/events';
import { type QueryState, useQuery } from '../data/query';
import { isAbortOrTimeout } from '../lib/timeout';
import { listPending } from '../sync/outbox';
import { EditError, FAILED_MESSAGE, OFFLINE_NOTE, TIMEOUT_MESSAGE } from './edits';
import type { GoalTaskOut } from './types';

export interface TaskItem {
  task: GoalTaskOut;
  done: boolean;
}

export interface GoalTasks {
  state: QueryState;
  stale: boolean;
  items: TaskItem[];
  done: number;
  total: number;
  toggle(id: string, done: boolean): Promise<void>;
  /** Adds a task (needs a connection): throws an `EditError` with the sentence to show. */
  add(title: string): Promise<void>;
  reload(): void;
}

const ADD_TIMEOUT_MS = 15_000;

/** The ticks still in the outbox, by task: the last one of each wins. */
async function queuedTicks(): Promise<Record<string, boolean>> {
  const out: Record<string, boolean> = {};
  for (const event of await listPending().catch(() => [])) {
    if (event.type !== 'goal_task_set') continue;
    const payload = event.payload as { task_id?: unknown; done?: unknown };
    if (typeof payload.task_id === 'string' && typeof payload.done === 'boolean') out[payload.task_id] = payload.done;
  }
  return out;
}

export function useGoalTasks(ref: string): GoalTasks {
  const query = useQuery(`goal-tasks:${ref}`, () =>
    api
      .GET('/v1/goals/{ref}/tasks', { params: { path: { ref } } })
      .then(unwrap)
      .then((r) => r.items),
  );
  const [queued, setQueued] = useState<Record<string, boolean>>({});
  const [added, setAdded] = useState<GoalTaskOut[]>([]);

  // Ticks made before this page was opened, still waiting to be sent.
  useEffect(() => {
    let alive = true;
    void queuedTicks().then((ticks) => {
      if (alive) setQueued((now) => ({ ...ticks, ...now }));
    });
    return () => {
      alive = false;
    };
  }, [ref]);

  const items = useMemo<TaskItem[]>(() => {
    const loaded = query.data ?? [];
    const known = new Set(loaded.map((t) => t.id));
    return [...loaded, ...added.filter((t) => !known.has(t.id))]
      .filter((t) => !t.archived)
      .map((task) => ({ task, done: queued[task.id] ?? task.done_at !== null }));
  }, [query.data, added, queued]);

  const toggle = useCallback(async (id: string, done: boolean): Promise<void> => {
    setQueued((now) => ({ ...now, [id]: done }));
    await setGoalTask(id, done);
  }, []);

  const add = useCallback(
    async (title: string): Promise<void> => {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new EditError(OFFLINE_NOTE);
      try {
        const result = await api.POST('/v1/goals/{ref}/tasks', {
          params: { path: { ref } },
          body: { title },
          signal: AbortSignal.timeout(ADD_TIMEOUT_MS),
        });
        if (!result.response.ok || result.data === undefined) throw new EditError(FAILED_MESSAGE);
        const created = result.data;
        setAdded((now) => [...now, created]);
      } catch (error: unknown) {
        if (error instanceof EditError) throw error;
        if (isAbortOrTimeout(error)) throw new EditError(TIMEOUT_MESSAGE);
        if (error instanceof TypeError) throw new EditError(OFFLINE_NOTE);
        throw error;
      }
    },
    [ref],
  );

  return {
    state: query.state,
    stale: query.stale,
    items,
    done: items.filter((i) => i.done).length,
    total: items.length,
    toggle,
    add,
    reload: query.reload,
  };
}
