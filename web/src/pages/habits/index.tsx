import { useLocation } from 'preact-iso';
import { useState } from 'preact/hooks';

import { useHabitsToday } from '../../habits/useHabitsToday';
import { countByFilter, matchesFilter, type StatusFilterValue } from '../../progress/state';
import { Segmented } from '../../ui/Segmented';
import { Skeleton } from '../../ui/Skeleton';
import { StateFrame } from '../../ui/StateFrame';
import { Toast } from '../../ui/Toast';
import { useLogNote } from '../home/useLogNote';
import { HabitGroups } from './HabitGroups';
import { inScope, parseScope, parseStatus, type Scope } from './scope';
import { StatusFilter } from './StatusFilter';
import './habits.css';

const SCOPE_OPTIONS: readonly { value: Scope; label: string }[] = [
  { value: 'today', label: 'اليوم' },
  { value: 'week', label: 'الأسبوع' },
  { value: 'cycle', label: 'الدورة' },
];

/** What each choice of the scope switch shows, said under it. A habit that is not in force (upcoming,
 *  ended, archived) is never hidden by it: only the status filter hides it. */
const SCOPE_NOTE: Record<Scope, string> = {
  today: 'العادات المجدولة اليوم.',
  week: 'العادات الأسبوعية السارية.',
  cycle: 'كل عادة سارية، مجدولة اليوم أو لا.',
};
const SCOPE_NOTE_TAIL = 'القادمة والمنتهية والمؤرشفة تتبع الحالة وحدها.';

/** What a filter with nothing in it says. */
const NOTHING: Record<StatusFilterValue, string> = {
  active: 'لا عادة فعّالة في هذا العرض.',
  done: 'لا عادة منجزة في هذا العرض.',
  late: 'لا عادة متأخرة في هذا العرض.',
  all: 'لا عادة في هذا العرض.',
};

function AddLink({ variant }: { variant: 'primary' | 'quiet' }) {
  return (
    <a class={`btn btn-${variant}`} href="/habits/new">
      عادة جديدة
    </a>
  );
}

function ListSkeleton() {
  return (
    <div class="habits-skeleton">
      <Skeleton blockSize="var(--hit)" inlineSize="260px" />
      <Skeleton blockSize="var(--hit)" inlineSize="min(100%, 360px)" />
      <div class="card">
        <Skeleton blockSize="var(--fs-section)" inlineSize="30%" />
        <Skeleton blockSize="var(--hit)" />
        <Skeleton blockSize="var(--hit)" />
        <Skeleton blockSize="var(--hit)" />
        <Skeleton blockSize="var(--hit)" />
      </div>
    </div>
  );
}

export default function HabitsPage() {
  const habits = useHabitsToday('all');
  const location = useLocation();
  const status = parseStatus(location.query?.status);
  const scope = parseScope(location.query?.scope);
  const note = useLogNote(habits);

  // A habit logged on this page stays in the list until the filter or the scope changes, so a row
  // never vanishes under the finger (and keyboard focus is not lost); the chips count it at once.
  const key = `${status}|${scope}`;
  const [kept, setKept] = useState<{ key: string; codes: ReadonlySet<string> }>({ key, codes: new Set() });
  const keep = (code: string): void =>
    setKept((k) => ({ key, codes: new Set([...(k.key === key ? k.codes : []), code]) }));
  const pinned = kept.key === key ? kept.codes : new Set<string>();

  const choose = (next: { status?: StatusFilterValue; scope?: Scope }): void => {
    setKept({ key: '', codes: new Set() });
    const query = new URLSearchParams({ status: next.status ?? status, scope: next.scope ?? scope });
    location.route(`/habits?${query.toString()}`, true);
  };

  const scoped = habits.items.filter((item) => inScope(item, scope));
  const counts = countByFilter(scoped.map((item) => item.state));
  const shown = scoped.filter((item) => matchesFilter(item.state, status) || pinned.has(item.habit.code));
  const none = habits.items.length === 0;

  return (
    <>
      <div class="habits-head">
        <h1>العادات</h1>
        {!none && <AddLink variant="primary" />}
      </div>
      <StateFrame
        state={habits.state}
        stale={habits.stale}
        empty={none}
        emptyText="لا عادات بعد."
        emptyAction={<AddLink variant="primary" />}
        onRetry={habits.reload}
        skeleton={<ListSkeleton />}
      >
        <div class="habits-controls">
          <Segmented label="العرض" options={SCOPE_OPTIONS} value={scope} onChange={(value) => choose({ scope: value })} />
          <StatusFilter value={status} counts={counts} onChange={(value) => choose({ status: value })} />
        </div>
        <p class="habits-scope-note">{`${SCOPE_NOTE[scope]} ${SCOPE_NOTE_TAIL}`}</p>
        {shown.length === 0 ? (
          <p class="habits-none">{NOTHING[status]}</p>
        ) : (
          <div class="card habits-card">
            <HabitGroups
              items={shown}
              onTick={(code) => {
                keep(code);
                void habits.tick(code);
              }}
              onAdd={(code, step) => {
                keep(code);
                void habits.add(code, step);
              }}
              onUntick={(code) => {
                keep(code);
                note.untick(code);
              }}
              onSkip={(code) => {
                keep(code);
                void habits.skip(code);
              }}
            />
          </div>
        )}
      </StateFrame>
      <Toast message={note.message} action={note.action} onDismiss={note.message ? note.dismiss : undefined} />
    </>
  );
}
