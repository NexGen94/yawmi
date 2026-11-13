// What is late, and what it costs in numbers (design 9.2). `lateItems` lists the things the home
// page's section «المتأخر وغير المنجز» shows, and `impactSentence` says each in one sentence built
// from the numbers alone: no adjective, no blame, no advice.
//
// The habits and milestones counted here are the ones the server counts in its daily notice
// (`late_summary`: open milestones past their day, and habits whose state is `late` by
// `habit_state`). The goal-pace items are the browser's own addition (design 9.2); where the notice
// and this list disagree, the server is the fact.

import { fromOrdinal, toOrdinal } from '../domain/days';
import { strength } from '../domain/habits';
import { periodBounds } from '../domain/periods';
import type { Day, HabitLog, HabitSpec, WeekStart } from '../domain/types';
import { PLAN_START } from '../goals/types';
import type { GoalOutcome, GoalsOut, MilestoneFull } from '../goals/types';
import { toDomainLogs, type HabitLogOut } from '../data/pending';
import { habitSpecOf } from '../habits/spec';
import { roundUpNeed, type HabitTodayItem } from '../habits/useHabitsToday';
import { fmt, type Noun } from '../lib/format';
import { valueNum } from '../lib/value';
import { lastScheduledBefore } from './state';

export type LateItem =
  | {
      kind: 'habit_period';
      code: string;
      title: string;
      habitKind: 'boolean' | 'count' | 'duration';
      unit: '' | 'session' | 'min' | 'hour';
      period: 'week' | 'month';
      target: number;
      done: number;
      /** The days of the period that can still take a log, today included. */
      daysLeft: number;
      possible: boolean;
      /** The most a yes/no habit can still reach (`done` plus the days left). */
      maxReachable: number;
      needPerDay: number;
    }
  | {
      kind: 'habit_daily';
      code: string;
      title: string;
      strengthNow: number;
      strengthIfDone: number;
      /** `strength(spec, logs, today + 1)`, today having no log. */
      strengthIfMissed: number;
      /** The last scheduled day that was missed, when it was not yesterday. */
      missedDay?: Day;
    }
  | { kind: 'abstain_slip'; code: string; title: string; when: 'today' | 'yesterday'; strengthNow: number; strengthWithout: number }
  | {
      kind: 'milestone';
      pageId: string;
      title: string;
      dueDate: Day;
      overdueDays: number;
      outcomeCode: string;
      doneDue: number;
      totalDue: number;
    }
  | { kind: 'goal_pace'; ref: string; title: string; current: number; expected: number; projected: number; target: number };

// ---------- the words ----------

const PERIOD_NAME = { week: 'الأسبوع', month: 'الشهر' } as const;
const UNIT_NOUN: Record<'' | 'session' | 'min' | 'hour', Noun> = { '': 'time', session: 'session', min: 'minute', hour: 'hour' };

/** A quantity with its noun: «200 دقيقة», «ساعتان», «مرتان». */
function counted(n: number, unit: keyof typeof UNIT_NOUN): string {
  return fmt.count(n, UNIT_NOUN[unit]);
}

/** A number of days after a preposition («في 5 أيام», «في يومين», «في يوم واحد»): the dual is the oblique one. */
function daysAfter(n: number): string {
  if (n === 1) return 'يوم واحد';
  if (n === 2) return 'يومين';
  return fmt.count(n, 'day');
}

/** How late a milestone is, as the object of «متأخرة»: «يوماً واحداً», «يومين», «3 أيام», «11 يوماً». */
function lateBy(n: number): string {
  return n === 1 ? 'يوماً واحداً' : daysAfter(n);
}

const score = (ratio: number): string => fmt.num(Math.round(ratio * 100));

function periodSentence(item: Extract<LateItem, { kind: 'habit_period' }>): string {
  const remaining = item.target - item.done;
  const name = PERIOD_NAME[item.period];
  if (!item.possible) {
    return `لم يعد بلوغ هدف ${name} ممكناً: الباقي ${valueNum(remaining)} والأيام ${fmt.num(item.daysLeft)}. أقصى ما يُبلغ ${valueNum(item.maxReachable)} من ${valueNum(item.target)}.`;
  }
  const base = `يلزم ${counted(remaining, item.unit)} في ${daysAfter(item.daysLeft)} لبلوغ هدف ${name} (${valueNum(item.target)})`;
  // Only a duration has a daily need worth saying; a count or a yes/no habit is not spread over days.
  return item.habitKind === 'duration' ? `${base}، أي ${counted(item.needPerDay, item.unit)} يومياً.` : `${base}.`;
}

/** The sentence of one late item, from its numbers alone. */
export function impactSentence(item: LateItem): string {
  switch (item.kind) {
    case 'habit_period':
      return periodSentence(item);
    case 'habit_daily': {
      const missed = item.missedDay === undefined ? 'فاتت أمس' : `فاتت يوم ${item.missedDay}`;
      return `${missed}. درجة القوة ${score(item.strengthNow)}: إنجاز اليوم يجعلها ${score(item.strengthIfDone)}، وفواته ${score(item.strengthIfMissed)}.`;
    }
    case 'abstain_slip':
      return `انزلاق مسجَّل ${item.when === 'today' ? 'اليوم' : 'أمس'}. درجة القوة ${score(item.strengthNow)}، وبدونه ${score(item.strengthWithout)}.`;
    case 'milestone': {
      const late = `متأخرة ${lateBy(item.overdueDays)} عن موعدها ${item.dueDate}.`;
      if (item.outcomeCode === '') return late;
      return `${late} ${item.outcomeCode}: أُنجز ${fmt.num(item.doneDue)} من ${fmt.num(item.totalDue)} محطة حان موعدها.`;
    }
    case 'goal_pace':
      return `القيمة ${valueNum(item.current)} والمتوقع اليوم ${valueNum(item.expected)}. بالوتيرة الحالية يُبلغ ${valueNum(item.projected)} من ${valueNum(item.target)} عند الموعد.`;
  }
}

// ---------- the items ----------

export interface LateInput {
  /** Every habit with its state (`useHabitsToday('all')` or `allItems`), as the server counts them. */
  habits: readonly HabitTodayItem[];
  /** The logs of the last 62 days with the outbox over them: the strength sentences read them. */
  logs: readonly HabitLogOut[];
  goals?: GoalsOut;
  today: Day;
  weekStart: WeekStart;
}

function milestoneItems(goals: GoalsOut, today: Day): LateItem[] {
  const open = goals.milestones
    .filter((m): m is MilestoneFull & { due_date: Day } => !m.done && m.due_date !== null && m.due_date < today)
    .sort((a, b) => a.due_date.localeCompare(b.due_date) || a.title.localeCompare(b.title) || a.page_id.localeCompare(b.page_id));
  return open.map((m) => {
    // a milestone that serves no outcome has nothing to be counted against
    const due =
      m.outcome_code === null
        ? []
        : goals.milestones.filter((o) => o.outcome_code === m.outcome_code && o.due_date !== null && o.due_date <= today);
    return {
      kind: 'milestone',
      pageId: m.page_id,
      title: m.title,
      dueDate: m.due_date,
      overdueDays: toOrdinal(today) - toOrdinal(m.due_date),
      outcomeCode: m.outcome_code ?? '',
      doneDue: due.filter((o) => o.done).length,
      totalDue: due.length,
    };
  });
}

function periodItem(item: HabitTodayItem, today: Day, weekStart: WeekStart): LateItem {
  const { habit, progress } = item;
  const period = habit.period === 'month' ? 'month' : 'week';
  const bounds = periodBounds(today, period, weekStart);
  const last = habit.end_day !== null && habit.end_day < bounds.end ? habit.end_day : bounds.end;
  const left = Math.max(1, toOrdinal(last) - toOrdinal(today) + 1);
  // A yes/no habit logged today has used today: it cannot be logged again before the period ends.
  const available = habit.kind === 'boolean' && item.statusToday === 'done' ? Math.max(0, left - 1) : left;
  const remaining = Math.max(0, progress.target - progress.done);
  return {
    kind: 'habit_period',
    code: habit.code,
    title: habit.title_ar,
    habitKind: habit.kind,
    unit: habit.unit,
    period,
    target: progress.target,
    done: progress.done,
    daysLeft: available,
    possible: habit.kind !== 'boolean' || remaining <= available,
    maxReachable: habit.kind === 'boolean' ? progress.done + available : progress.target,
    needPerDay: roundUpNeed(remaining / Math.max(1, available), habit.unit),
  };
}

function dailyItem(item: HabitTodayItem, spec: HabitSpec, logs: HabitLog[], today: Day, weekStart: WeekStart): LateItem {
  const done: HabitLog = { day: today, value: spec.kind === 'boolean' ? null : spec.targetPerPeriod, status: 'done' };
  const withDone = [...logs.filter((l) => l.day !== today), done];
  const yesterday = fromOrdinal(toOrdinal(today) - 1);
  const missed = lastScheduledBefore(spec, today);
  const base = {
    kind: 'habit_daily' as const,
    code: item.habit.code,
    title: item.habit.title_ar,
    strengthNow: strength(spec, logs, today, weekStart),
    strengthIfDone: strength(spec, withDone, today, weekStart),
    // today stays without a log: the day passes, and the strength is taken at tomorrow
    strengthIfMissed: strength(spec, logs, fromOrdinal(toOrdinal(today) + 1), weekStart),
  };
  return missed !== null && missed !== yesterday ? { ...base, missedDay: missed } : base;
}

function slipItem(item: HabitTodayItem, spec: HabitSpec, logs: HabitLog[], today: Day, weekStart: WeekStart): LateItem {
  const when = logs.some((l) => l.status === 'done' && l.day === today) ? 'today' : 'yesterday';
  const slipDay = when === 'today' ? today : fromOrdinal(toOrdinal(today) - 1);
  return {
    kind: 'abstain_slip',
    code: item.habit.code,
    title: item.habit.title_ar,
    when,
    strengthNow: strength(spec, logs, today, weekStart),
    strengthWithout: strength(spec, logs.filter((l) => l.day !== slipDay), today, weekStart),
  };
}

function habitItems(input: LateInput): LateItem[] {
  const items: LateItem[] = [];
  for (const item of input.habits) {
    if (item.state !== 'late') continue;
    try {
      const spec = habitSpecOf(item.habit);
      const logs = toDomainLogs([...input.logs], item.habit.code);
      if (spec.polarity === 'abstain') items.push(slipItem(item, spec, logs, input.today, input.weekStart));
      else if (item.habit.period === 'day') items.push(dailyItem(item, spec, logs, input.today, input.weekStart));
      else items.push(periodItem(item, input.today, input.weekStart));
    } catch (error) {
      // A habit the rules refuse is left out rather than breaking the page.
      if (!(error instanceof RangeError)) throw error;
    }
  }
  return items;
}

/** An outcome measured by its milestones (the pace basis of design 9.4 when it has no KPI of its own)
 *  that is behind the straight line from the plan's start to its due day. An outcome with a KPI that
 *  has a target is paced on that KPI by the server, which the browser does not read here: it is left
 *  out rather than contradicted. */
function paceItem(outcome: GoalOutcome, today: Day): LateItem | null {
  if (outcome.kpis.some((k) => k.target !== null)) return null;
  const start = toOrdinal(PLAN_START);
  const due = toOrdinal(outcome.target_date);
  const now = toOrdinal(today);
  const target = outcome.milestones_total;
  if (target <= 0 || now <= start || due <= start) return null;
  const expected = target * Math.min(1, Math.max(0, (now - start) / (due - start)));
  const current = outcome.milestones_done;
  if (current >= expected - 1e-9) return null;
  return {
    kind: 'goal_pace',
    ref: outcome.code,
    title: outcome.title,
    current,
    expected,
    projected: (current * (due - start)) / (now - start),
    target,
  };
}

/** What is late today, in the order of the design: milestones past their day (oldest first), then
 *  the habits whose state is `late`, then the goals below their pace. */
export function lateItems(input: LateInput): LateItem[] {
  const { goals, today } = input;
  const milestones = goals === undefined ? [] : milestoneItems(goals, today);
  const paces = goals === undefined ? [] : goals.outcomes.flatMap((o) => paceItem(o, today) ?? []);
  return [...milestones, ...habitItems(input), ...paces];
}
