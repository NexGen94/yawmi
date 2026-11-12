// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/preact';
import { describe, expect, it, vi } from 'vitest';

import { HabitRow } from '../../src/habits/HabitRow';
import type { HabitTodayItem } from '../../src/habits/useHabitsToday';
import type { PeriodProgress } from '../../src/domain/types';
import { habit } from '../helpers/today-fixtures';

const progress = (over: Partial<PeriodProgress> = {}): PeriodProgress => ({
  done: 1,
  target: 1,
  completion: 1,
  reached: true,
  expected: 1,
  onTrack: true,
  needPerDay: 0,
  ...over,
});

function abstainItem(status: HabitTodayItem['statusToday'], over: Partial<PeriodProgress> = {}): HabitTodayItem {
  return {
    habit: { ...habit('no_sugar', 'ترك السكر'), polarity: 'abstain' } as HabitTodayItem['habit'],
    progress: progress(over),
    statusToday: status,
    valueToday: null,
    group: 'free',
  };
}

function renderRow(item: HabitTodayItem) {
  const handlers = { onTick: vi.fn(), onValue: vi.fn(), onSkip: vi.fn() };
  render(
    <ul>
      <HabitRow item={item} {...handlers} />
    </ul>,
  );
  return handlers;
}

describe('HabitRow: an abstain habit', () => {
  it('says «نظيف اليوم» when nothing is logged and the day is kept', () => {
    renderRow(abstainItem(null));
    expect(screen.getByText('نظيف اليوم')).toBeTruthy();
  });

  it('one tap on «تسجيل انزلاق» calls onTick once', () => {
    const { onTick } = renderRow(abstainItem(null));
    fireEvent.click(screen.getByRole('button', { name: /^تسجيل انزلاق/ }));
    expect(onTick).toHaveBeenCalledTimes(1);
  });

  it('says «انزلاق مسجَّل اليوم» for a slip, and offers no second slip', () => {
    renderRow(abstainItem('done', { done: 0, reached: false }));
    expect(screen.getByText('انزلاق مسجَّل اليوم')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^تسجيل انزلاق/ })).toBeNull();
  });

  it('a skipped day is not «نظيف اليوم» and not a slip either', () => {
    renderRow(abstainItem('skip', { done: 0, reached: false }));
    expect(screen.queryByText('نظيف اليوم')).toBeNull();
    expect(screen.queryByText('انزلاق مسجَّل اليوم')).toBeNull();
    expect(screen.getByText('متخطّاة اليوم')).toBeTruthy();
  });

  it('a vacation day is neither', () => {
    renderRow(abstainItem('vacation', { done: 0, reached: false }));
    expect(screen.queryByText('نظيف اليوم')).toBeNull();
    expect(screen.queryByText('انزلاق مسجَّل اليوم')).toBeNull();
    expect(screen.getByText('إجازة اليوم')).toBeTruthy();
  });

  it('an unscheduled day with nothing logged is not «نظيف اليوم» (reached is false)', () => {
    renderRow(abstainItem(null, { done: 0, reached: false }));
    expect(screen.queryByText('نظيف اليوم')).toBeNull();
    expect(screen.queryByText('انزلاق مسجَّل اليوم')).toBeNull();
  });

  it('never shows a need per day', () => {
    renderRow(abstainItem(null, { done: 0, reached: false, needPerDay: 0.5 }));
    expect(screen.queryByText(/المطلوب يومياً/)).toBeNull();
  });
});

describe('HabitRow: a build habit', () => {
  const build = (over: Partial<HabitTodayItem> = {}): HabitTodayItem => ({
    habit: habit('read', 'القراءة', { kind: 'duration', unit: 'min', target_per_period: 20 }),
    progress: progress({ done: 5, target: 20, reached: false, completion: 0.25, needPerDay: 15 }),
    statusToday: 'done',
    valueToday: 5,
    group: 'free',
    ...over,
  });

  it('«+5» calls onValue with the day total', () => {
    const { onValue } = renderRow(build());
    fireEvent.click(screen.getByRole('button', { name: /^\+5/ }));
    expect(onValue).toHaveBeenCalledWith(10);
  });

  it('a tap on a row that is already done does not log again', () => {
    const done = build({ progress: progress({ done: 20, target: 20 }), valueToday: 20 });
    const { onTick } = renderRow(done);
    fireEvent.click(screen.getByRole('button', { pressed: true }));
    expect(onTick).not.toHaveBeenCalled();
  });

  it('a yes/no habit has no «+» button', () => {
    renderRow({ ...build(), habit: habit('walk', 'المشي'), progress: progress({ done: 0, reached: false }) });
    expect(screen.queryByRole('button', { name: /^\+/ })).toBeNull();
  });
});
