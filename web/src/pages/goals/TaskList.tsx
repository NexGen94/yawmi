import { useState } from 'preact/hooks';

import { EditError, FAILED_MESSAGE, OFFLINE_NOTE } from '../../goals/edits';
import type { GoalTasks } from '../../goals/tasks';
import { fmt } from '../../lib/format';
import { CheckRow } from '../../ui/CheckRow';
import { Field } from '../../ui/Field';
import { Skeleton } from '../../ui/Skeleton';

const MAX_TITLE = 200;

export interface TaskListProps {
  tasks: GoalTasks;
  online: boolean;
}

/** The goal's own small list (design 13.1, ruling 2). A tick is an event in the outbox, so it works
 *  without a connection and the counter moves at once; adding a task needs a connection. Nothing is
 *  deleted here. */
export function TaskList({ tasks, online }: TaskListProps) {
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const add = async (event: Event): Promise<void> => {
    event.preventDefault();
    const text = title.trim();
    if (text === '' || busy) return;
    setBusy(true);
    setError('');
    try {
      await tasks.add(text);
      setTitle('');
    } catch (failure: unknown) {
      setError(failure instanceof EditError && failure.message ? failure.message : FAILED_MESSAGE);
    } finally {
      setBusy(false);
    }
  };

  const loading = tasks.state === 'loading' && tasks.items.length === 0;
  return (
    <>
      {tasks.state === 'error' && (
        <p class="gd-none" role="alert">
          تعذّر تحميل المهام.
        </p>
      )}
      {loading && <Skeleton blockSize="var(--hit)" />}
      {!loading && tasks.state !== 'error' && (
        <>
          {tasks.total > 0 && <p class="task-count">{`${fmt.num(tasks.done)} من ${fmt.num(tasks.total)}`}</p>}
          {tasks.total === 0 && <p class="gd-none">لا مهام بعد.</p>}
          <ul class="task-list">
            {tasks.items.map(({ task, done }) => (
              <li key={task.id}>
                <CheckRow
                  shape="square"
                  checked={done}
                  label={task.title}
                  note={task.due_day ? fmt.day(task.due_day) : undefined}
                  onToggle={(next) => void tasks.toggle(task.id, next)}
                />
              </li>
            ))}
          </ul>
        </>
      )}
      <form class="task-add" onSubmit={(event) => void add(event)}>
        <Field label="عنوان المهمة" value={title} onInput={setTitle} maxLength={MAX_TITLE} disabled={!online || busy} />
        <div class="edit-actions">
          <button type="submit" class="btn btn-quiet" disabled={!online || busy}>
            إضافة مهمة
          </button>
          {!online && <span class="edit-offline">{OFFLINE_NOTE}</span>}
        </div>
        {error !== '' && (
          <p class="edit-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </>
  );
}
