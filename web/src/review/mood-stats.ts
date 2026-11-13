// What the mood tab and the journal tab count (design 4, 9.5): the average mood on the days of a habit
// against the other days, the mood of a year, and the figures of each month. Pure: the page reads the
// data. These are descriptions of what happened, never causes (the screen says «للوعي الذاتي»).

import { fromOrdinal, toOrdinal } from '../domain/days';
import { isScheduled } from '../domain/periods';
import type { Day, HabitSpec } from '../domain/types';
import type { HabitLogOut, JournalEntryOut, MoodLogOut } from '../data/pending';
import { habitSpecOf } from '../habits/spec';
import type { HabitOut } from '../habits/types';
import { fmt, getDigits } from '../lib/format';
import { valueNum } from '../lib/value';

export type { MoodLogOut };

/** The fewest days a side needs before the figure is shown (design 9.5). */
export const MIN_DAYS = 5;

export interface ActivityMood {
  code: string;
  title: string;
  /** The mean mood on the days the habit was done. */
  withAvg: number;
  /** The mean mood on the other days of its life. */
  withoutAvg: number;
}

/** The mean of the scores, or null when there is no day. */
export function moodAverage(logs: readonly Pick<MoodLogOut, 'score'>[]): number | null {
  if (logs.length === 0) return null;
  return logs.reduce((sum, l) => sum + l.score, 0) / logs.length;
}

type DayKind = 'done' | 'neutral' | 'open';

/** What a habit did on each day: `done` (a yes/no habit with a done log, any other with a value above
 *  zero), `neutral` (skipped or vacation without a done log), or nothing. */
function dayKinds(habit: HabitOut, logs: readonly HabitLogOut[]): Map<Day, DayKind> {
  const kinds = new Map<Day, DayKind>();
  for (const log of logs) {
    if (log.habit_code !== habit.code) continue;
    const counts = habit.kind === 'boolean' || (log.value ?? 0) > 0;
    if (log.status === 'done' && counts) kinds.set(log.day, 'done');
    else if ((log.status === 'skip' || log.status === 'vacation') && kinds.get(log.day) !== 'done') kinds.set(log.day, 'neutral');
  }
  return kinds;
}

/**
 * For each habit: the mean mood on the days it was done against the mean on the other days, shown
 * only when each side has at least `minDays` days with a mood (design 9.5). The other days are those
 * of the habit's own life (from its start, to its end, on its schedule) that it was neither done nor
 * skipped. An abstain habit is not an activity (a done log there is a slip), so it has no row. The
 * rows keep the order of `habits`.
 */
export function moodByActivity(
  mood: readonly MoodLogOut[],
  logs: readonly HabitLogOut[],
  habits: readonly HabitOut[],
  minDays = MIN_DAYS,
): ActivityMood[] {
  const rows: ActivityMood[] = [];
  for (const habit of habits) {
    const spec = activitySpec(habit);
    if (spec === null) continue;
    const { withDays, withoutDays } = splitMood(habit, spec, mood, dayKinds(habit, logs));
    if (withDays.length < minDays || withoutDays.length < minDays) continue;
    rows.push({
      code: habit.code,
      title: habit.title_ar,
      withAvg: moodAverage(withDays) ?? 0,
      withoutAvg: moodAverage(withoutDays) ?? 0,
    });
  }
  return rows;
}

/** The rule input of a habit that can be an activity: not an abstain habit, and one the rules accept. */
function activitySpec(habit: HabitOut): HabitSpec | null {
  if (habit.polarity === 'abstain') return null;
  try {
    return habitSpecOf(habit);
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}

/** The day is inside the life of the habit: from its start to its end. */
const inLife = (habit: HabitOut, day: Day): boolean => day >= habit.start_day && (habit.end_day == null || day <= habit.end_day);

/** The days with a mood, split into those the habit was done and the other days of its life it was
 *  scheduled and neither done nor skipped. A done day outside its life is a stray log: it counts for
 *  neither side. */
function splitMood(
  habit: HabitOut,
  spec: HabitSpec,
  mood: readonly MoodLogOut[],
  kinds: ReadonlyMap<Day, DayKind>,
): { withDays: MoodLogOut[]; withoutDays: MoodLogOut[] } {
  const withDays: MoodLogOut[] = [];
  const withoutDays: MoodLogOut[] = [];
  for (const entry of mood) {
    const kind = kinds.get(entry.day);
    if (kind === 'neutral' || !inLife(habit, entry.day)) continue;
    if (kind === 'done') withDays.push(entry);
    else if (isScheduled(entry.day, spec)) withoutDays.push(entry);
  }
  return { withDays, withoutDays };
}

// ---------- the year ----------

export interface YearDay {
  day: Day;
  score: number;
}

/** The mood of one calendar year, one score a day (the last log of a day wins), by day. */
export function yearDays(logs: readonly MoodLogOut[], year: number): YearDay[] {
  const prefix = `${String(year).padStart(4, '0')}-`;
  const byDay = new Map<Day, number>();
  for (const log of logs) if (log.day.startsWith(prefix)) byDay.set(log.day, log.score);
  return [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, score]) => ({ day, score }));
}

/** The label of the year grid: its year, how many days have a mood, and their average. */
export function yearLabel(year: number, days: readonly { score: number }[]): string {
  const name = `المزاج في ${fmt.num(year, { useGrouping: false })}`;
  const average = moodAverage(days);
  if (average === null) return `${name}: لا بيانات بعد`;
  return `${name}: ${fmt.count(days.length, 'day')} مسجّلة، المتوسط ${valueNum(average)}`;
}

// ---------- the months ----------

export interface MonthGroup {
  /** `YYYY-MM`. */
  month: string;
  /** Days with a morning journal. */
  morning: number;
  /** Days with an evening journal. */
  evening: number;
  /** Days with a mood. */
  moodDays: number;
  moodAvg: number | null;
}

/** The month of a day, `YYYY-MM`. */
export function monthKey(day: Day): string {
  return day.slice(0, 7);
}

/** The figures of each month that has a journal or a mood, the newest month first. */
export function monthGroups(journal: readonly JournalEntryOut[], mood: readonly MoodLogOut[]): MonthGroup[] {
  const groups = new Map<string, { morning: Set<Day>; evening: Set<Day>; scores: Map<Day, number> }>();
  const of = (month: string) => {
    let group = groups.get(month);
    if (group === undefined) {
      group = { morning: new Set(), evening: new Set(), scores: new Map() };
      groups.set(month, group);
    }
    return group;
  };
  for (const entry of journal) of(monthKey(entry.day))[entry.part].add(entry.day);
  for (const log of mood) of(monthKey(log.day)).scores.set(log.day, log.score);
  return [...groups.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([month, g]) => ({
      month,
      morning: g.morning.size,
      evening: g.evening.size,
      moodDays: g.scores.size,
      moodAvg: moodAverage([...g.scores.values()].map((score) => ({ score }))),
    }));
}

/** «نوفمبر 2026»: the month and the year, Gregorian, in the digits of the setting. */
export function monthLabel(month: string): string {
  const [year, number] = month.split('-').map(Number) as [number, number];
  const name = new Intl.DateTimeFormat(`ar-SA-u-ca-gregory-nu-${getDigits()}`, { month: 'long', timeZone: 'UTC' }).format(
    new Date(Date.UTC(year, number - 1, 15)),
  );
  return `${name} ${fmt.num(year, { useGrouping: false })}`;
}

/** The days with an evening journal, in the form the morning uses: a single day and two days are
 *  words («يوم»، «يومان») in both, any other count is the numeral (the morning adds the noun). */
function eveningDays(n: number): string {
  return n === 1 || n === 2 ? fmt.count(n, 'day') : fmt.num(n);
}

/** The sentence of a month card (feature 15, ruling 16): the days with an entry, the mood, and the
 *  words that say it is for self-awareness. There is no watch data in it. */
export function monthSentence(group: MonthGroup): string {
  const mood = group.moodAvg === null ? 'لا تسجيل للمزاج' : `متوسط المزاج ${valueNum(group.moodAvg)}`;
  return `${monthLabel(group.month)}: ${fmt.count(group.morning, 'day')} صباحاً، ${eveningDays(group.evening)} مساءً، ${mood} · للوعي الذاتي`;
}

/** The ISO day `n` days before `day`. */
export function daysBefore(day: Day, n: number): Day {
  return fromOrdinal(toOrdinal(day) - n);
}
