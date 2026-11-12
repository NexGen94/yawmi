// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/preact';
import { describe, expect, it, vi } from 'vitest';

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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

describe('HabitRow: the identity sentence', () => {
  const withIdentity = (over: Partial<HabitTodayItem['habit']> = {}): HabitTodayItem => ({
    habit: habit('read', 'القراءة', { identity_text: 'أنا شخص يقرأ كل يوم', ...over }),
    progress: progress({ done: 0, reached: false, completion: 0 }),
    statusToday: null,
    valueToday: null,
    group: 'free',
    state: 'active',
    dueToday: true,
  });

  it('shows under the title of a build habit when it exists', () => {
    renderRow(withIdentity());
    expect(screen.getByText('أنا شخص يقرأ كل يوم')).toBeTruthy();
    const button = screen.getByRole('button', { pressed: false });
    expect(button.textContent).toContain('أنا شخص يقرأ كل يوم');
  });

  it('shows under the title of an abstain habit too', () => {
    renderRow(withIdentity({ polarity: 'abstain' }));
    expect(screen.getByText('أنا شخص يقرأ كل يوم')).toBeTruthy();
  });

  it('draws nothing when there is none', () => {
    renderRow(withIdentity({ identity_text: null }));
    expect(document.querySelector('.habit-identity')).toBeNull();
  });
});

describe('HabitRow: a habit that is not live today', () => {
  const staticItem = (state: HabitTodayItem['state'], over: Partial<HabitTodayItem['habit']> = {}, dueToday = false): HabitTodayItem => ({
    habit: habit('challenge', 'تحدٍّ', over),
    progress: progress({ done: 0, reached: false, completion: 0 }),
    statusToday: null,
    valueToday: null,
    group: 'free',
    state,
    dueToday,
  });

  it('an ended habit says «انتهت مدتها» and offers no tick, no skip', () => {
    renderRow(staticItem('ended', { end_day: '2026-10-30' }));
    expect(screen.getByText('انتهت مدتها')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('an upcoming habit says when it starts', () => {
    renderRow(staticItem('upcoming', { start_day: '2026-11-15' }));
    // a badge (design 9.1), with the date through fmt.day (the digits setting applies)
    expect(document.querySelector('.badge')?.textContent).toBe('تبدأ في الأحد، 15 نوفمبر 2026');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('an archived habit says «مؤرشفة»', () => {
    renderRow(staticItem('archived', { active: false }));
    expect(screen.getByText('مؤرشفة')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('a live habit that is not scheduled today says so and logs nothing', () => {
    renderRow(staticItem('active', { schedule_kind: 'weekdays', weekday_mask: 64 }));
    expect(screen.getByText('غير مجدولة اليوم')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('keeps the outcome badge', () => {
    renderRow(staticItem('ended', { outcome: 'O4' }));
    expect(screen.getByText('O4')).toBeTruthy();
  });
});

describe('HabitRow: the state words of the habits page (showState)', () => {
  const live = (state: HabitTodayItem['state']): HabitTodayItem => ({
    habit: habit('read', 'القراءة'),
    progress: progress({ done: 1, reached: state === 'done' }),
    statusToday: state === 'done' ? 'done' : null,
    valueToday: null,
    group: 'free',
    state,
    dueToday: true,
  });
  const renderShown = (item: HabitTodayItem) =>
    render(
      <ul>
        <HabitRow item={item} showState onTick={vi.fn()} onAdd={vi.fn()} onUntick={vi.fn()} onSkip={vi.fn()} />
      </ul>,
    );

  it('a habit that reached its period says «تحقق هدف الفترة»', () => {
    renderShown(live('done'));
    expect(screen.getByText(/تحقق هدف الفترة/)).toBeTruthy();
  });

  it('a late daily habit carries the badge «متأخرة»', () => {
    renderShown(live('late'));
    expect(screen.getByText('متأخرة')).toBeTruthy();
  });

  it('a weekly or monthly habit behind its pace says «دون وتيرة الأسبوع» or «دون وتيرة الشهر», not «متأخرة»', () => {
    const weekly = { ...live('late'), habit: habit('w', 'أسبوعية', { period: 'week', target_per_period: 3 }) };
    const { unmount } = renderShown(weekly);
    expect(screen.getByText('دون وتيرة الأسبوع')).toBeTruthy();
    expect(screen.queryByText('متأخرة')).toBeNull();
    unmount();
    renderShown({ ...weekly, habit: habit('m', 'شهرية', { period: 'month', target_per_period: 3 }) });
    expect(screen.getByText('دون وتيرة الشهر')).toBeTruthy();
  });

  it('the home list says neither (no showState)', () => {
    renderRow(live('done'));
    expect(screen.queryByText(/تحقق هدف الفترة/)).toBeNull();
    renderRow(live('late'));
    expect(screen.queryByText('متأخرة')).toBeNull();
  });
});

describe('the notice leaves room at the end of the page', () => {
  it('a page with a toast pads its block end so the last card is never covered', () => {
    const layout = readFileSync(resolve(import.meta.dirname, '../../src/styles/layout.css'), 'utf8');
    expect(layout).toMatch(/\.page:has\(\.toast\)\s*\{[^}]*padding-block-end:/);
  });
});
