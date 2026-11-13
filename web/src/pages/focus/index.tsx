import { useLocation } from 'preact-iso';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';

import { HourBars, hourText } from '../../charts/HourBars';
import { combine } from '../../data/combine';
import { type FocusPlanOut, focusTarget, hourBins, minutesOn, PRESET_MINUTES } from '../../focus/calc';
import { SESSION_WINDOW_DAYS, useFocusPlans, useFocusSessions } from '../../focus/data';
import { useGoals, useOnline, useToday } from '../../goals/data';
import { resolveGoal, titleOf } from '../../goals/target';
import { useHabitsToday } from '../../habits/useHabitsToday';
import { fmt } from '../../lib/format';
import { useSettings } from '../../settings/data';
import { Card } from '../../ui/Card';
import { Disclosure } from '../../ui/Disclosure';
import { Skeleton } from '../../ui/Skeleton';
import { StateFrame } from '../../ui/StateFrame';
import { useDayEntries } from '../home/useDayEntries';
import { FocusScore } from './FocusScore';
import { PlansList, PlanTools, StoppedPlans } from './PlansList';
import { useAllFocusPlans } from './plans';
import { ScheduledBlocks } from './ScheduledBlocks';
import { SessionTimer } from './SessionTimer';
import { useFocusSession } from './useSession';
import './focus.css';

const DEFAULT_MINUTES = PRESET_MINUTES[0];

/** The minutes the morning journal planned for the day, when it holds a number. */
function plannedOf(answers: Record<string, unknown> | undefined): number | null {
  const planned = answers?.planned_minutes;
  return typeof planned === 'number' ? planned : null;
}

export default function FocusPage() {
  const day = useToday();
  const online = useOnline();
  const { query } = useLocation();
  const plans = useFocusPlans();
  const allPlans = useAllFocusPlans();
  const sessions = useFocusSessions(day);
  const settings = useSettings();
  const entries = useDayEntries(day);
  const habits = useHabitsToday('all');
  const goals = useGoals();
  const focus = useFocusSession(habits, sessions.refresh);

  // What the next session will be: the minutes, a plan and a goal, from the links `?plan` and `?goal`
  // or from the person's choice. A plan fills all three.
  const planParam = query?.plan;
  const goalParam = query?.goal;
  const planList: FocusPlanOut[] = plans.data ?? [];
  const [minutes, setMinutes] = useState<number>(DEFAULT_MINUTES);
  const [planId, setPlanId] = useState<string | null>(null);
  const [goalRef, setGoalRef] = useState<string | null>(goalParam ?? null);
  const appliedPlan = useRef<string | null>(null);

  const choose = (plan: FocusPlanOut): void => {
    setPlanId(plan.id);
    setMinutes(plan.minutes);
    setGoalRef(plan.goal_ref ?? goalParam ?? null);
  };
  useEffect(() => {
    if (goalParam) setGoalRef(goalParam);
  }, [goalParam]);
  useEffect(() => {
    if (!planParam || appliedPlan.current === planParam) return;
    const found = planList.find((p) => p.id === planParam);
    if (found === undefined) return;
    appliedPlan.current = planParam;
    setPlanId(found.id);
    setMinutes(found.minutes);
    setGoalRef(found.goal_ref ?? goalParam ?? null);
  }, [planParam, goalParam, planList]);

  const plan = planList.find((p) => p.id === planId) ?? null;
  const goal = goals.data !== undefined && goalRef !== null ? resolveGoal(goals.data, goalRef) : undefined;
  const goalTitle = goal === undefined ? null : titleOf(goal);

  // A reading that is repeated after a change keeps showing what it has: only the first one is a loading state.
  const settled = <T,>(q: { state: 'loading' | 'ready' | 'error' | 'offline'; stale: boolean; data: T | undefined }) =>
    q.state === 'loading' && q.data !== undefined ? { state: 'ready' as const, stale: false } : q;
  const { state, stale } = combine(settled(plans), settled(sessions.query));
  const minutesToday = minutesOn(sessions.sessions, day);
  const target = focusTarget(
    plannedOf(entries.morning?.answers as Record<string, unknown> | undefined),
    settings.data?.focus_daily_target_min,
  );
  const bins = useMemo(() => hourBins(sessions.sessions), [sessions.sessions]);

  const habitChoices = habits.allItems
    .filter((i) => i.habit.kind === 'duration' && (i.habit.unit === 'min' || i.habit.unit === 'hour'))
    .map((i) => ({ code: i.habit.code, title: i.habit.title_ar }));
  // The active list and the list with the stopped ones are read together after a change.
  const reloadPlans = (): void => {
    plans.reload();
    allPlans.reload();
  };
  const stopped = (allPlans.data ?? []).filter((p) => !p.active);
  const tools = { online, habits: habitChoices, goalRef, onChanged: reloadPlans };
  const empty = plans.data !== undefined && plans.data.length === 0 && sessions.query.data !== undefined && sessions.sessions.length === 0;

  return (
    <div class="focus-page">
      <h1>التركيز</h1>
      <SessionTimer
        focus={focus}
        plans={planList}
        selection={{ minutes, plan, goalRef }}
        goalTitle={goalTitle}
        onMinutes={(n) => {
          setMinutes(n);
          setPlanId(null);
        }}
        onClearPlan={() => setPlanId(null)}
        onClearGoal={() => setGoalRef(null)}
      />
      <StateFrame
        state={state}
        stale={stale}
        empty={empty}
        emptyText="لا خطط ولا جلسات بعد"
        emptyAction={
          <>
            <PlanTools {...tools} />
            <StoppedPlans plans={stopped} online={online} onChanged={reloadPlans} />
          </>
        }
        onRetry={() => {
          plans.reload();
          sessions.query.reload();
        }}
        skeleton={
          <div class="focus-col">
            <Skeleton blockSize="180px" />
            <Skeleton blockSize="180px" />
          </div>
        }
      >
        <div class="page-cols">
          <div class="focus-col">
            <PlansList {...tools} plans={planList} chosenId={planId} onChoose={choose} />
            <ScheduledBlocks plans={planList} />
            <StoppedPlans plans={stopped} online={online} onChanged={reloadPlans} />
          </div>
          <div class="focus-col">
            <FocusScore minutes={minutesToday} target={target} />
            <Card title="توزيع الساعات" class="focus-hours">
              <HourBars bins={bins} />
              <p class="focus-note">{`آخر ${fmt.count(SESSION_WINDOW_DAYS, 'day')}، بتوقيت الرياض`}</p>
              <Disclosure summary="جدول الساعات">
                <HoursTable bins={bins} />
              </Disclosure>
            </Card>
          </div>
        </div>
      </StateFrame>
    </div>
  );
}

function HoursTable({ bins }: { bins: number[] }) {
  const rows = bins.map((m, hour) => ({ hour, m })).filter((r) => r.m > 0);
  if (rows.length === 0) return <p class="focus-note">لا بيانات بعد</p>;
  return (
    <ul class="focus-hours-list">
      {rows.map((r) => (
        <li key={r.hour}>{`${hourText(r.hour)} · ${fmt.count(Math.round(r.m), 'minute')}`}</li>
      ))}
    </ul>
  );
}
