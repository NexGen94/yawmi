import { useLocation } from 'preact-iso';
import { useEffect, useRef } from 'preact/hooks';

import { Timeline } from '../../charts/Timeline';
import { type GoalTable, TABLES } from '../../goals/columns';
import { isEmptyMirror, useGoalColumns, useGoals, useOnline, useToday } from '../../goals/data';
import { Segmented } from '../../ui/Segmented';
import { Skeleton } from '../../ui/Skeleton';
import { StateFrame } from '../../ui/StateFrame';
import { CycleCard } from './CycleCard';
import { DomainCards } from './DomainCards';
import { DueReport } from './DueReport';
import { GoalsTable } from './GoalsTable';
import { Horizons } from './Horizons';
import { OutcomeTree } from './OutcomeTree';
import { PendingBadge } from './PendingBadge';
import './goals.css';

type View = 'tree' | 'table' | 'due' | 'timeline' | 'horizons';

const VIEWS: readonly { value: View; label: string }[] = [
  { value: 'tree', label: 'الشجرة' },
  { value: 'table', label: 'الجدول' },
  { value: 'due', label: 'الأقرب استحقاقاً' },
  { value: 'timeline', label: 'الخط الزمني' },
  { value: 'horizons', label: 'الآفاق' },
];

const parseView = (raw: string | undefined): View => VIEWS.find((v) => v.value === raw)?.value ?? 'tree';
const parseTable = (raw: string | undefined): GoalTable => TABLES.find((t) => t === raw) ?? 'milestones';

function GoalsSkeleton() {
  return (
    <div class="goals-skeleton">
      <Skeleton blockSize="96px" />
      <div class="domain-grid">
        <Skeleton blockSize="180px" />
        <Skeleton blockSize="180px" />
        <Skeleton blockSize="180px" />
        <Skeleton blockSize="180px" />
      </div>
      <Skeleton blockSize="var(--hit)" inlineSize="420px" />
      <Skeleton blockSize="240px" />
    </div>
  );
}

export default function GoalsPage() {
  const switchBox = useRef<HTMLDivElement>(null);
  const goals = useGoals();
  const location = useLocation();
  const today = useToday();
  const online = useOnline();
  const columns = useGoalColumns();
  const view = parseView(location.query?.view);
  const table = parseTable(location.query?.table);
  const data = goals.data;

  // Five views do not fit one row on a phone: the chosen one is brought into sight.
  useEffect(() => {
    switchBox.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.scrollIntoView?.({ block: 'nearest', inline: 'center' });
  }, [view, data !== undefined]);

  const choose = (next: { view?: View; table?: GoalTable }): void => {
    const query = new URLSearchParams({ view: next.view ?? view });
    if ((next.view ?? view) === 'table') query.set('table', next.table ?? table);
    location.route(`/goals?${query.toString()}`, true);
  };

  return (
    <>
      <div class="goals-head">
        <h1>الأهداف</h1>
        {data !== undefined && <PendingBadge goals={data} />}
      </div>
      <StateFrame
        state={goals.state}
        stale={goals.stale}
        empty={data !== undefined && isEmptyMirror(data)}
        emptyText="لم تُنسخ الخطة من Notion بعد"
        onRetry={goals.reload}
        skeleton={<GoalsSkeleton />}
      >
        {data !== undefined && (
          <div class="goals-body">
            <CycleCard goals={data} today={today} />
            <DomainCards outcomes={data.outcomes} />
            <div class="goals-switch" ref={switchBox}>
              <Segmented label="العرض" options={VIEWS} value={view} onChange={(value) => choose({ view: value })} />
            </div>
            <div class="goals-view">
              {view === 'tree' && <OutcomeTree goals={data} today={today} />}
              {view === 'table' && (
                <GoalsTable
                  goals={data}
                  table={table}
                  columns={columns.columns[table]}
                  online={online}
                  columnsKnown={columns.known}
                  columnsLoading={columns.loading}
                  onTable={(next) => choose({ view: 'table', table: next })}
                  onSaveColumns={(keys) => columns.save(table, keys)}
                />
              )}
              {view === 'due' && <DueReport milestones={data.milestones} today={today} />}
              {view === 'timeline' && (
                <Timeline cycles={data.cycles} milestones={data.milestones} today={today} label="الخط الزمني للخطة" />
              )}
              {view === 'horizons' && <Horizons goals={data} today={today} />}
            </div>
          </div>
        )}
      </StateFrame>
    </>
  );
}
