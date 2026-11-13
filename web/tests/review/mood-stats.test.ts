import { describe, expect, it } from 'vitest';

import { fromOrdinal, toOrdinal } from '../../src/domain/days';
import {
  moodAverage,
  moodByActivity,
  monthGroups,
  monthKey,
  monthLabel,
  monthSentence,
  type MoodLogOut,
  yearDays,
  yearLabel,
} from '../../src/review/mood-stats';
import { habit, type HabitLogOut, type JournalEntryOut } from '../helpers/today-fixtures';

const FIRST = '2026-10-31';
const day = (n: number): string => fromOrdinal(toOrdinal(FIRST) + n);
const mood = (d: string, score: number): MoodLogOut => ({ day: d, score, feelings: [], activities: [] });
const done = (habit_code: string, d: string, value: number | null = null): HabitLogOut => ({ habit_code, day: d, value, status: 'done' });

/** The example of design 9.5: on the days of the walk the mood averages 4.1 (29 over 7 days), on the
 *  other ten days 3.4. */
function story(): { moods: MoodLogOut[]; logs: HabitLogOut[] } {
  const withWalk = [4, 4, 4, 4, 4, 4, 5];
  const without = [3, 3, 3, 3, 3, 3, 4, 4, 4, 4];
  const moods = [...withWalk, ...without].map((score, i) => mood(day(i), score));
  const logs = withWalk.map((_, i) => done('walk', day(i)));
  return { moods, logs };
}

const WALK = habit('walk', 'المشي');

describe('moodByActivity', () => {
  it('the mood on the days of a habit against the other days: 4.1 and 3.4', () => {
    const { moods, logs } = story();
    const [row, ...rest] = moodByActivity(moods, logs, [WALK]);
    expect(rest).toEqual([]);
    expect(row?.code).toBe('walk');
    expect(row?.title).toBe('المشي');
    expect(row?.withAvg).toBeCloseTo(29 / 7, 9);
    expect(Math.round((row?.withAvg ?? 0) * 10) / 10).toBe(4.1);
    expect(row?.withoutAvg).toBeCloseTo(3.4, 9);
  });

  it('a habit with only four days on one side is not in the result (five is enough)', () => {
    const { moods, logs } = story();
    // four days with the habit
    expect(moodByActivity(moods, logs.slice(0, 4), [WALK])).toEqual([]);
    // five days with it, and the other twelve without
    expect(moodByActivity(moods, logs.slice(0, 5), [WALK])).toHaveLength(1);
    // four days without it: the habit is done on all but four of the seventeen days
    const nearly = moods.map((m) => done('walk', m.day));
    expect(moodByActivity(moods, nearly.slice(0, 13), [WALK])).toEqual([]);
    expect(moodByActivity(moods, nearly.slice(0, 12), [WALK])).toHaveLength(1);
  });

  it('the least number of days is a parameter', () => {
    const { moods, logs } = story();
    expect(moodByActivity(moods, logs.slice(0, 4), [WALK], 4)).toHaveLength(1);
    expect(moodByActivity(moods, logs, [WALK], 8)).toEqual([]);
  });

  it('only days with a mood count, so a log on a day without one changes nothing', () => {
    const { moods, logs } = story();
    const extra = [done('walk', day(40)), done('walk', day(41))];
    const [row] = moodByActivity(moods, [...logs, ...extra], [WALK]);
    expect(row?.withAvg).toBeCloseTo(29 / 7, 9);
  });

  it('a skipped or vacation day is in neither side, and a done day without a value of a duration habit is not done', () => {
    const { moods, logs } = story();
    const skip: HabitLogOut = { habit_code: 'walk', day: day(8), status: 'skip', value: null };
    const [row] = moodByActivity(moods, [...logs, skip], [WALK]);
    // day 8 scored 3: it leaves the "without" side (nine days, 3.44)
    expect(row?.withoutAvg).toBeCloseTo(31 / 9, 9);
    const minutes = habit('minutes', 'دقائق', { kind: 'duration', unit: 'min', target_per_period: 30 });
    const noValue = logs.map((l) => ({ ...l, habit_code: 'minutes', value: null }));
    expect(moodByActivity(moods, noValue, [minutes])).toEqual([]);
    const withValue = logs.map((l) => ({ ...l, habit_code: 'minutes', value: 20 }));
    expect(moodByActivity(moods, withValue, [minutes])).toHaveLength(1);
  });

  it('the days before the habit started, or after it ended, are not "without" it', () => {
    const { moods, logs } = story();
    const young = habit('walk', 'المشي', { start_day: day(5) });
    // logs on days 0 to 6; only days 5 and 6 are inside the habit's life: two days with it
    expect(moodByActivity(moods, logs, [young])).toEqual([]);
    const finished = habit('walk', 'المشي', { end_day: day(9) });
    const [row] = moodByActivity(moods, logs, [finished]);
    // seventeen days minus the seven days after the end (10 to 16) leave three without it
    expect(row).toBeUndefined();
  });

  it('an abstain habit is not an activity: a done log there is a slip', () => {
    const { moods, logs } = story();
    expect(moodByActivity(moods, logs, [habit('walk', 'المشي', { polarity: 'abstain' })])).toEqual([]);
  });

  it('keeps the order of the habits and gives one row for each that qualifies', () => {
    const { moods, logs } = story();
    const read = habit('read', 'القراءة');
    const readLogs = moods.slice(10).map((m) => done('read', m.day));
    const rows = moodByActivity(moods, [...logs, ...readLogs], [read, WALK]);
    expect(rows.map((r) => r.code)).toEqual(['read', 'walk']);
  });

  it('is empty without moods, without habits, or without logs', () => {
    const { moods, logs } = story();
    expect(moodByActivity([], logs, [WALK])).toEqual([]);
    expect(moodByActivity(moods, logs, [])).toEqual([]);
    expect(moodByActivity(moods, [], [WALK])).toEqual([]);
  });
});

describe('moodAverage', () => {
  it('is the mean of the scores, or null without a day', () => {
    expect(moodAverage([mood('2026-11-01', 4), mood('2026-11-02', 3)])).toBe(3.5);
    expect(moodAverage([])).toBeNull();
  });
});

describe('the year', () => {
  it('yearDays keeps the scores of one year, one score a day, in order', () => {
    const logs = [mood('2026-03-01', 2), mood('2025-12-31', 5), mood('2026-01-01', 4), mood('2027-01-01', 3)];
    expect(yearDays(logs, 2026)).toEqual([
      { day: '2026-01-01', score: 4 },
      { day: '2026-03-01', score: 2 },
    ]);
  });

  it('yearLabel names the year, the days with a mood and their average', () => {
    const days = [
      { day: '2026-11-01', score: 4 },
      { day: '2026-11-02', score: 4 },
      { day: '2026-11-03', score: 3 },
    ];
    const text = yearLabel(2026, days);
    expect(text).toContain('2026');
    expect(text).toContain('3 أيام');
    expect(text).toContain('3.7');
    expect(yearLabel(2026, [])).toContain('لا بيانات');
  });
});

describe('monthGroups', () => {
  const entry = (d: string, part: 'morning' | 'evening'): JournalEntryOut => ({ day: d, part, answers: {}, logged_at: `${d}T10:00:00Z` });

  it('the key of a day is its month', () => {
    expect(monthKey('2026-11-09')).toBe('2026-11');
  });

  it('counts the days with a morning and with an evening entry, and the mood, of each month, newest month first', () => {
    const journal = [
      ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => entry(`2026-11-0${n}`, 'morning')),
      ...[1, 2, 3, 4, 5, 6, 7].map((n) => entry(`2026-11-0${n}`, 'evening')),
      entry('2026-10-31', 'morning'),
    ];
    const moods = [4, 4, 4, 4, 4, 4, 3, 4, 4].map((score, i) => mood(`2026-11-0${i + 1}`, score));
    const groups = monthGroups(journal, moods);
    expect(groups.map((g) => g.month)).toEqual(['2026-11', '2026-10']);
    expect(groups[0]).toMatchObject({ morning: 9, evening: 7, moodDays: 9 });
    expect(groups[0]?.moodAvg).toBeCloseTo(35 / 9, 9);
    expect(groups[1]).toMatchObject({ morning: 1, evening: 0, moodDays: 0, moodAvg: null });
  });

  it('a month with a mood and no journal still has its card', () => {
    const groups = monthGroups([], [mood('2026-09-15', 2)]);
    expect(groups).toEqual([{ month: '2026-09', morning: 0, evening: 0, moodDays: 1, moodAvg: 2 }]);
  });
});

describe('the month sentence', () => {
  it('names the month, the days of each journal and the mood, for self-awareness', () => {
    expect(monthLabel('2026-11')).toBe('نوفمبر 2026');
    const group = { month: '2026-11', morning: 9, evening: 7, moodDays: 9, moodAvg: 35 / 9 };
    expect(monthSentence(group)).toBe('نوفمبر 2026: 9 أيام صباحاً، 7 مساءً، متوسط المزاج 3.9 · للوعي الذاتي');
  });

  it('says so when no mood was logged in the month, and has no watch figure', () => {
    const text = monthSentence({ month: '2026-10', morning: 1, evening: 0, moodDays: 0, moodAvg: null });
    expect(text).toBe('أكتوبر 2026: يوم صباحاً، 0 مساءً، لا تسجيل للمزاج · للوعي الذاتي');
  });
});

describe('the month sentence: one form for the two journals (fix round 1, M-1)', () => {
  const group = (morning: number, evening: number) => ({ month: '2026-09', morning, evening, moodDays: 0, moodAvg: null });

  it('one and one: the same word for both', () => {
    expect(monthSentence(group(1, 1))).toBe('سبتمبر 2026: يوم صباحاً، يوم مساءً، لا تسجيل للمزاج · للوعي الذاتي');
  });

  it('two and two, and the plural and zero keep the numeral for the evening as in the brief', () => {
    expect(monthSentence(group(2, 2))).toContain('يومان صباحاً، يومان مساءً');
    expect(monthSentence(group(9, 7))).toContain('9 أيام صباحاً، 7 مساءً');
    expect(monthSentence(group(0, 0))).toContain('0 أيام صباحاً، 0 مساءً');
  });

  it('the same count is written the same way in the morning and in the evening, whatever the count', () => {
    for (let n = 0; n <= 40; n += 1) {
      const text = monthSentence(group(n, n));
      const morning = text.split('، ')[0]?.split(': ')[1] ?? '';
      const evening = text.split('، ')[1] ?? '';
      // the morning word, without «صباحاً»; the evening word, without «مساءً»
      const m = morning.replace(' صباحاً', '');
      const e = evening.replace(' مساءً', '');
      const word = n === 1 || n === 2;
      expect(word ? e : e).toBe(word ? m : String(n));
    }
  });
});
