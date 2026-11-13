// The numbers of the weekly review (design 4, the week tab): what the habits and the journal did in
// the week that holds `today`, in the words of the plan's criteria. Pure: the page reads the data
// and this only counts. Every habit judgement is the rule of `../domain` or `../progress/state`, so
// the review can never disagree with the habits page.

import { fromOrdinal, toOrdinal } from '../domain/days';
import { periodProgress } from '../domain/habits';
import { isScheduled, periodBounds } from '../domain/periods';
import type { Day, HabitLog, HabitSpec, WeekStart } from '../domain/types';
import { toDomainLogs, type HabitLogOut, type JournalEntryOut } from '../data/pending';
import type { GoalsOut } from '../goals/types';
import { habitSpecOf } from '../habits/spec';
import type { HabitOut } from '../habits/types';
import { habitState } from '../progress/state';

/** The acceptance criteria the weekly review measures, in the order it draws them. */
export const CRITERIA = ['AC3.4', 'AC2.7', 'AC7.4'] as const;
export type Criterion = (typeof CRITERIA)[number];

/** How far ahead «التالي» looks for milestones (design 4: the next 14 days). */
export const NEXT_DAYS = 14;

export interface WeekSummaryInput {
  habits: readonly HabitOut[];
  /** The logs of the habits, as the server gives them (they carry the habit's code). */
  logs: readonly HabitLogOut[];
  journal: readonly JournalEntryOut[];
  /** The mirror of the plan: its absence leaves the milestone lines empty. */
  goals?: GoalsOut;
  today: Day;
  weekStart: WeekStart;
}

export interface WeekSummary {
  /** The days kept of the daily habits: `reached` up to today, of `total` in the whole week. */
  adherence: { reached: number; total: number };
  /** The days of the week with a morning journal and with an evening journal. */
  journal: { morning: number; evening: number };
  /** One row for each criterion some habit carries; the others are not drawn. */
  byCriterion: { ac: Criterion; done: number; target: number }[];
  /** Habits that met their target this week. */
  done: string[];
  /** Habits whose state is late, and open milestones past their day. */
  blocked: string[];
  /** Open milestones due in the next 14 days, nearest first. */
  next: string[];
}

/** The week (first and last day) that holds `day`. */
export function weekBounds(day: Day, weekStart: WeekStart): { start: Day; end: Day } {
  return periodBounds(day, 'week', weekStart);
}

interface Prepared {
  habit: HabitOut;
  spec: HabitSpec;
  logs: HabitLog[];
}

const inRange = (day: Day, first: Day, last: Day): boolean => day >= first && day <= last;

/** A day has `skip` or `vacation` and no done log: it is neutral, in no count. */
function isNeutral(logs: readonly HabitLog[], day: Day): boolean {
  const mine = logs.filter((l) => l.day === day);
  return mine.some((l) => l.status === 'skip' || l.status === 'vacation') && !mine.some((l) => l.status === 'done');
}

function prepare(habit: HabitOut, logs: readonly HabitLogOut[]): Prepared | null {
  try {
    return { habit, spec: habitSpecOf(habit), logs: toDomainLogs([...logs], habit.code) };
  } catch (error) {
    // A habit the rules refuse is left out rather than breaking the review.
    if (error instanceof RangeError) return null;
    throw error;
  }
}

/** The scheduled days of the habit inside [first, last], as days. */
function scheduledDays(spec: HabitSpec, first: Day, last: Day): Day[] {
  const out: Day[] = [];
  for (let ord = toOrdinal(first); ord <= toOrdinal(last); ord += 1) {
    const day = fromOrdinal(ord);
    if (isScheduled(day, spec)) out.push(day);
  }
  return out;
}

/** The first and last day of the habit's own life inside the week, or null when it has no day there. */
function lifeInWeek(habit: HabitOut, start: Day, end: Day): { first: Day; last: Day } | null {
  const first = habit.start_day > start ? habit.start_day : start;
  const last = habit.end_day != null && habit.end_day < end ? habit.end_day : end;
  return first <= last ? { first, last } : null;
}

function journalCounts(journal: readonly JournalEntryOut[], start: Day, last: Day): WeekSummary['journal'] {
  const days = { morning: new Set<Day>(), evening: new Set<Day>() };
  for (const entry of journal) if (inRange(entry.day, start, last)) days[entry.part].add(entry.day);
  return { morning: days.morning.size, evening: days.evening.size };
}

/** The days of the daily habits (design 9.6): a build habit keeps a day by meeting its target, an
 *  abstain habit by having no slip. A skipped day is in neither number, a day after today is only in
 *  the total, and the total is the whole week as the server counts it for the AI. */
function adherenceOf(items: readonly Prepared[], start: Day, end: Day, today: Day, weekStart: WeekStart): WeekSummary['adherence'] {
  let reached = 0;
  let total = 0;
  for (const { habit, spec, logs } of items) {
    if (habit.period !== 'day') continue;
    const life = lifeInWeek(habit, start, end);
    if (life === null) continue;
    for (const day of scheduledDays(spec, life.first, life.last)) {
      if (isNeutral(logs, day)) continue;
      total += 1;
      if (day <= today && periodProgress(spec, logs, day, weekStart).reached) reached += 1;
    }
  }
  return { reached, total };
}

function byCriterion(items: readonly Prepared[], start: Day, today: Day, weekStart: WeekStart): WeekSummary['byCriterion'] {
  const rows: WeekSummary['byCriterion'] = [];
  for (const ac of CRITERIA) {
    const mine = items.filter(
      ({ habit, spec }) =>
        habit.ac_ref === ac &&
        habit.active &&
        habit.period === 'week' &&
        spec.polarity !== 'abstain' &&
        habit.start_day <= today &&
        (habit.end_day == null || habit.end_day >= start),
    );
    if (mine.length === 0) continue;
    // Habits of one criterion that count the same thing add up (the two journals); when they count
    // different things (minutes and sessions) the one with the larger target is the criterion.
    const [head = mine[0] as Prepared] = mine;
    const lead = mine.reduce((a, b) => (b.habit.target_per_period > a.habit.target_per_period ? b : a), head);
    const same = mine.filter((m) => m.habit.kind === lead.habit.kind && m.habit.unit === lead.habit.unit);
    let done = 0;
    let target = 0;
    for (const { spec, logs } of same) {
      const progress = periodProgress(spec, logs, today, weekStart);
      done += progress.done;
      target += progress.target;
    }
    rows.push({ ac, done, target });
  }
  return rows;
}

/** A habit that met its target in the week: a weekly or monthly one reached it with a log in the
 *  week; a daily one kept every scheduled day up to today (today only once it has a log). */
function metTarget({ habit, spec, logs }: Prepared, start: Day, end: Day, today: Day, weekStart: WeekStart): boolean {
  const life = lifeInWeek(habit, start, end);
  if (life === null || habit.start_day > today) return false;
  const last = today < life.last ? today : life.last;
  if (habit.period !== 'day') {
    const inWeek = logs.some((l) => l.status === 'done' && inRange(l.day, start, last));
    return inWeek && periodProgress(spec, logs, today, weekStart).reached;
  }
  const kept = scheduledDays(spec, life.first, last).filter(
    (day) => !isNeutral(logs, day) && (day < today || logs.some((l) => l.day === day)),
  );
  return kept.length > 0 && kept.every((day) => periodProgress(spec, logs, day, weekStart).reached);
}

const byDueDay = (a: { due_date: Day; title: string }, b: { due_date: Day; title: string }): number =>
  a.due_date.localeCompare(b.due_date) || a.title.localeCompare(b.title);

export function weekSummary(input: WeekSummaryInput): WeekSummary {
  const { habits, logs, journal, goals, today, weekStart } = input;
  const { start, end } = weekBounds(today, weekStart);
  const last = today < end ? today : end;

  const items = habits.flatMap((habit) => prepare(habit, logs) ?? []);
  const live = items.filter(({ habit }) => habit.active && habit.start_day <= end && (habit.end_day == null || habit.end_day >= start));
  const build = live.filter(({ spec }) => spec.polarity !== 'abstain');

  const late = items.filter(({ habit, logs: mine }) => habitState(habit, mine, today, weekStart) === 'late');
  const openMilestones = (goals?.milestones ?? []).flatMap((m) =>
    !m.done && m.due_date !== null ? [{ title: m.title, due_date: m.due_date }] : [],
  );
  const horizon = fromOrdinal(toOrdinal(today) + NEXT_DAYS);

  return {
    adherence: adherenceOf(live, start, end, today, weekStart),
    journal: journalCounts(journal, start, last),
    byCriterion: byCriterion(items, start, today, weekStart),
    done: build.filter((p) => metTarget(p, start, end, today, weekStart)).map((p) => p.habit.title_ar),
    blocked: [
      ...late.map((p) => p.habit.title_ar),
      ...openMilestones.filter((m) => m.due_date < today).sort(byDueDay).map((m) => m.title),
    ],
    next: openMilestones
      .filter((m) => m.due_date >= today && m.due_date <= horizon)
      .sort(byDueDay)
      .map((m) => m.title),
  };
}
