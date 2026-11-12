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
    habit: habit('no_sugar', 'ترك السكر', { polarity: 'abstain' }),
    progress: progress(over),
    statusToday: status,
    valueToday: null,
    group: 'free',
    state: 'active',
    dueToday: true,
  };
}

function renderRow(item: HabitTodayItem) {
  const handlers = { onTick: vi.fn(), onAdd: vi.fn(), onUntick: vi.fn(), onSkip: vi.fn() };
  render(
    <ul>
      <HabitRow item={item} {...handlers} />
    </ul>,
  );
  return handlers;
}

describe('HabitRow: an abstain habit', () => {
  it('has no check mark and no pressed state: its marker is not a done button', () => {
    renderRow(abstainItem(null));
    expect(document.querySelector('.check-mark')).toBeNull();
    expect(document.querySelector('[aria-pressed]')).toBeNull();
    expect(document.querySelector('.habit-abstain-mark')?.tagName).toBe('SPAN');
  });

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
    state: 'active',
    dueToday: true,
    ...over,
  });

  it('«+5» calls onAdd with the step, never with a total computed from the render', () => {
    const { onAdd } = renderRow(build());
    fireEvent.click(screen.getByRole('button', { name: /^\+5/ }));
    expect(onAdd).toHaveBeenCalledWith(5);
  });

  it('a tap on a row that is already done calls onUntick, not onTick', () => {
    const done = build({ progress: progress({ done: 20, target: 20 }), valueToday: 20 });
    const { onTick, onUntick } = renderRow(done);
    fireEvent.click(screen.getByRole('button', { pressed: true }));
    expect(onUntick).toHaveBeenCalledTimes(1);
    expect(onTick).not.toHaveBeenCalled();
  });

  it('describes a done row as unsent or sent, so the tap says what it will do', () => {
    const done = build({ progress: progress({ done: 20, target: 20 }), valueToday: 20, unsent: true });
    renderRow(done);
    const button = screen.getByRole('button', { pressed: true });
    const text = (button.getAttribute('aria-describedby') ?? '')
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ');
    expect(text).toContain('لم يُرسل بعد');
  });

  it('a yes/no habit has no «+» button', () => {
    renderRow({ ...build(), habit: habit('walk', 'المشي'), progress: progress({ done: 0, reached: false }) });
    expect(screen.queryByRole('button', { name: /^\+/ })).toBeNull();
  });
});
