import type { ComponentChildren } from 'preact';
import { useMemo } from 'preact/hooks';

import { PaceLine, paceNum } from '../../charts/PaceLine';
import { Code } from '../../goals/Code';
import { useOnline, useToday } from '../../goals/data';
import { cancelEdit, editCard, editMilestone, redoEdit, useGoalEdits } from '../../goals/edits';
import { useEditableGoals } from '../../goals/editable';
import { DASH, pctOrDash } from '../../goals/format';
import { Iso } from '../../goals/Iso';
import { usePace } from '../../goals/pace';
import { useGoalTasks } from '../../goals/tasks';
import { habitHref, milestonesOf, resolveGoal, titleOf, titlesOf, type GoalTarget } from '../../goals/target';
import type { CardFull, GoalEditOut, MilestoneFull, PaceOut } from '../../goals/types';
import { type HabitTodayItem, useHabitsToday } from '../../habits/useHabitsToday';
import { fmt } from '../../lib/format';
import { Badge } from '../../ui/Badge';
import { Card } from '../../ui/Card';
import { Skeleton } from '../../ui/Skeleton';
import { StateFrame } from '../../ui/StateFrame';
import { Toast } from '../../ui/Toast';
import { useLogNote } from '../home/useLogNote';
import { EditField } from './EditField';
import { EditLog } from './EditLog';
import { type LinkedHabit, LinkedHabits } from './LinkedHabits';
import { MilestoneList, type MilestoneEditInput } from './MilestoneList';
import { TaskList } from './TaskList';
import './detail.css';

function DetailSkeleton() {
  return (
    <div class="gd-skeleton">
      <Skeleton blockSize="120px" />
      <Skeleton blockSize="200px" />
      <Skeleton blockSize="160px" />
    </div>
  );
}

const Facts = ({ children }: { children: ComponentChildren }) => <dl class="gd-facts">{children}</dl>;
const Fact = ({ name, children }: { name: string; children: ComponentChildren }) => (
  <div>
    <dt>{name}</dt>
    <dd>{children}</dd>
  </div>
);

/** What the pace says in words: the numbers beside the chart, and whether the pace is met only when
 *  the server says so (nothing is said for a goal with nothing to measure). */
function PaceCard({ pace }: { pace: PaceOut }) {
  const num = paceNum;
  const unit = pace.unit ? ` ${pace.unit}` : '';
  return (
    <Card title="الوتيرة">
      <PaceLine pace={pace} label="وتيرة الهدف" />
      <Facts>
        <Fact name="القيمة">{pace.current_value === null ? 'لا قراءة بعد' : `${num(pace.current_value)}${unit}`}</Fact>
        <Fact name="المتوقع اليوم">{`${num(pace.expected_today)}${unit}`}</Fact>
        {pace.projected_end !== null && <Fact name="المتوقع عند الموعد">{`${num(pace.projected_end)} من ${num(pace.target_value)}${unit}`}</Fact>}
        <Fact name="الموعد">
          <bdi>{fmt.day(pace.due_day)}</bdi>
        </Fact>
      </Facts>
      {pace.on_pace === true && <Badge>على الوتيرة</Badge>}
      {pace.on_pace === false && <Badge tone="signal">دون الوتيرة المتوقعة</Badge>}
    </Card>
  );
}

function Summary({
  target,
  online,
  statuses,
  onStatus,
}: {
  target: GoalTarget;
  online: boolean;
  statuses: string[];
  onStatus(card: CardFull, status: string): Promise<void>;
}) {
  if (target.kind === 'outcome') {
    const o = target.outcome;
    return (
      <Card title="الهدف">
        <p class="gd-acceptance">
          <Iso text={o.acceptance} />
        </p>
        <Facts>
          <Fact name="الإنجاز">{`${fmt.num(o.milestones_done)} من ${fmt.num(o.milestones_total)} محطة · ${pctOrDash(o.completion)}`}</Fact>
          <Fact name="الموعد">
            <bdi>{fmt.day(o.target_date)}</bdi>
          </Fact>
        </Facts>
      </Card>
    );
  }
  if (target.kind === 'card') {
    const c = target.card;
    return (
      <Card title="البطاقة">
        <EditField
          kind="select"
          label="الحالة"
          value={c.status}
          options={[...new Set([...(c.status ? [c.status] : []), ...statuses])].map((s) => ({ value: s, label: s }))}
          pending={c.pending.includes('status')}
          disabled={!online}
          onSave={(status) => onStatus(c, status)}
        />
        <Facts>
          <Fact name="الموعد المستهدف">{c.target_date === null ? DASH : <bdi>{fmt.day(c.target_date)}</bdi>}</Fact>
          <Fact name="الخطوة التالية">{c.next_step ?? DASH}</Fact>
          <Fact name="المحطات">{`${fmt.num(c.milestones_done)} من ${fmt.num(c.milestones_total)}`}</Fact>
        </Facts>
      </Card>
    );
  }
  const m = target.milestone;
  return (
    <Card title="المحطة">
      {m.criterion && <p class="gd-acceptance">{m.criterion}</p>}
      <Facts>
        {target.outcome && (
          <Fact name="المخرج">
            <a href={`/goals/${encodeURIComponent(target.outcome.code)}`}>
              <Code code={target.outcome.code} /> {target.outcome.title}
            </a>
          </Fact>
        )}
        {target.cards.length > 0 && (
          <Fact name="البطاقات">
            {target.cards.map((c, i) => (
              <span key={c.page_id}>
                {i > 0 && '، '}
                <a href={`/goals/${encodeURIComponent(c.page_id)}`}>{c.title}</a>
              </span>
            ))}
          </Fact>
        )}
      </Facts>
    </Card>
  );
}

/** The habits that serve the goal: those of an outcome or a card as the plan lists them, and for a
 *  milestone those whose own link names it. */
function linkedOf(target: GoalTarget, items: HabitTodayItem[]): LinkedHabit[] {
  if (target.kind === 'outcome') return target.outcome.habits;
  if (target.kind === 'card') return target.card.habits;
  return items
    .filter((i) => i.habit.goal_ref === target.ref)
    .map((i) => ({ code: i.habit.code, title_ar: i.habit.title_ar, adherence: null, total_done: null }));
}

export interface GoalDetailProps {
  /** Filled in by the router from `/goals/:ref`: an outcome code, a card or a milestone page. */
  params?: { ref?: string };
}

/** One page per reference: moving to another goal from a link on this page starts it anew. */
export default function GoalDetailPage(props: GoalDetailProps) {
  return <GoalDetail key={props.params?.ref ?? ''} {...props} />;
}

function GoalDetail({ params }: GoalDetailProps) {
  const ref = params?.ref ?? '';
  const goals = useEditableGoals();
  const online = useOnline();
  const today = useToday();
  const { pace, refresh: refreshPace } = usePace(ref);
  const edits = useGoalEdits();
  const tasks = useGoalTasks(ref);
  const habits = useHabitsToday('all');
  const note = useLogNote(habits);

  const data = goals.data;
  const target = data === undefined ? undefined : resolveGoal(data, ref);
  const missing = data !== undefined && target === undefined;
  const titles = useMemo(() => (target === undefined ? new Map<string, string>() : titlesOf(target)), [target]);
  const mine = useMemo(() => (edits.items ?? []).filter((e) => titles.has(e.page_id)), [edits.items, titles]);
  const statuses = useMemo(() => [...new Set((data?.cards ?? []).map((c) => c.status).filter((s): s is string => !!s))], [data]);

  // One source for every number: after an edit the plan (the summary), the pace and the log are read
  // again, so the row, the summary and the pace line always say the same.
  const reread = (): Promise<unknown> => Promise.all([goals.refetch(), refreshPace(), edits.refresh()]);
  const editMilestoneOf = async (m: MilestoneFull, change: MilestoneEditInput): Promise<void> => {
    goals.replaceMilestone(await editMilestone(m.page_id, change));
    void reread();
  };
  const editStatus = async (card: CardFull, status: string): Promise<void> => {
    goals.replaceCard(await editCard(card.page_id, status));
    void reread();
  };
  const cancel = async (edit: GoalEditOut): Promise<void> => {
    await cancelEdit(edit.id);
    // the shown value goes back to the base value: the plan says which that is
    await reread();
  };
  const redo = async (edit: GoalEditOut): Promise<void> => {
    const row = await redoEdit(edit);
    if ('due_date' in row) goals.replaceMilestone(row);
    else goals.replaceCard(row);
    await reread();
  };

  const title = target === undefined ? 'تفاصيل الهدف' : titleOf(target);
  const href = target === undefined ? undefined : habitHref(target, pace);
  const state = goals.state;

  return (
    <>
      <div class="gd-head">
        <h1>{title}</h1>
        {target?.kind === 'outcome' && (
          <Badge>
            <Code code={target.outcome.code} />
          </Badge>
        )}
      </div>
      <StateFrame
        state={state}
        stale={goals.stale}
        empty={missing}
        emptyText="لا هدف بهذا المعرّف."
        emptyAction={
          <a class="btn btn-quiet" href="/goals">
            الأهداف
          </a>
        }
        onRetry={() => {
          goals.reload();
          edits.reload();
          tasks.reload();
        }}
        skeleton={<DetailSkeleton />}
      >
        {target !== undefined && (
          <>
            <div class="gd-actions">
              {href !== undefined ? (
                <a class="btn btn-primary" href={href}>
                  عادة من هذا الهدف
                </a>
              ) : (
                <p class="gd-none">لا محطة مفتوحة ولا بطاقة لبدء عادة منها</p>
              )}
              <a class="btn btn-quiet" href={`/focus?goal=${encodeURIComponent(ref)}`}>
                بدء تركيز
              </a>
            </div>
            {/* the indicator card of the goal goes here (task 17) */}
            <div class="page-cols">
              <div class="gd-col">
                <Summary target={target} online={online} statuses={statuses} onStatus={editStatus} />
                {pace != null && <PaceCard pace={pace} />}
                <Card title="المحطات">
                  <MilestoneList
                    milestones={milestonesOf(target)}
                    today={today}
                    online={online}
                    linked={target.kind !== 'milestone'}
                    onEdit={editMilestoneOf}
                  />
                </Card>
              </div>
              <div class="gd-col">
                <Card title="العادات المرتبطة">
                  <LinkedHabits
                    habits={linkedOf(target, habits.items)}
                    items={habits.items}
                    newHabitHref={href}
                    onTick={(code) => void habits.tick(code)}
                    onAdd={(code, step) => void habits.add(code, step)}
                  />
                </Card>
                <Card title="المهام">
                  <TaskList tasks={tasks} online={online} />
                </Card>
                <Card title="سجل التعديلات">
                  <EditLog items={edits.items === undefined ? undefined : mine} all={edits.items} state={edits.state} titles={titles} online={online} onCancel={cancel} onRedo={redo} />
                </Card>
              </div>
            </div>
          </>
        )}
      </StateFrame>
      <Toast message={note.message} action={note.action} onDismiss={note.message ? note.dismiss : undefined} />
    </>
  );
}
