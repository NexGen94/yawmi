import { CheckRow } from '../ui/CheckRow';
import { Badge } from '../ui/Badge';
import { nextDayValue } from '../data/pending';
import { fmt, type Noun } from '../lib/format';
import { isCleanToday, isDoneToday, polarityOf, type HabitTodayItem } from './useHabitsToday';
import type { HabitUnit } from './types';

export interface HabitRowProps {
  item: HabitTodayItem;
  /** The check mark: logs the habit done (a count or duration: today's share). */
  onTick(): void;
  /** Logs `value` as today's total (the «+5» button). */
  onValue(value: number): void;
  onSkip(): void;
}

const NOUN: Record<HabitUnit, Noun> = { min: 'minute', hour: 'hour', session: 'session', '': 'time' };

/** The quick increment of a count or duration habit, and how it is read aloud. */
const STEP: Record<HabitUnit, { step: number; noun: string }> = {
  min: { step: 5, noun: 'دقائق' },
  hour: { step: 0.5, noun: 'ساعة' },
  session: { step: 1, noun: 'جلسة' },
  '': { step: 1, noun: 'مرة' },
};

/** Keeps a phrase whole when a note wraps. */
const NBSP = String.fromCharCode(0xa0);

const PERIOD_WORD = { day: 'اليوم', week: 'هذا الأسبوع', month: 'هذا الشهر' } as const;

function amount(n: number, unit: HabitUnit): string {
  const text = fmt.count(n, NOUN[unit]);
  // «جلسة» and «جلستان» alone would read as a label, not a quantity.
  return n === 1 || n === 2 ? `${fmt.num(n)} ${text}` : text;
}

/** The second line of a build habit: the status of today, then the progress of the period. */
function buildNote(item: HabitTodayItem): string | undefined {
  const { habit, progress, statusToday } = item;
  const parts: string[] = [];
  if (statusToday === 'skip') parts.push('متخطّاة اليوم');
  if (statusToday === 'vacation') parts.push('إجازة اليوم');
  if (habit.kind === 'boolean' && habit.period === 'day') return parts[0];
  const unit: HabitUnit = habit.kind === 'boolean' ? '' : habit.unit;
  parts.push(`${fmt.num(progress.done)} من ${amount(progress.target, unit)} ${PERIOD_WORD[habit.period]}`);
  if (habit.period !== 'day' && !progress.reached && progress.needPerDay > 0) {
    // Non-breaking spaces keep the phrase whole when the note wraps.
    parts.push(`المطلوب${NBSP}يومياً:${NBSP}${amount(Math.ceil(progress.needPerDay * 10 - 1e-9) / 10, unit).replace(' ', NBSP)}`);
  }
  return parts.join(' · ');
}

/** The second line of an abstain habit. No need per day: it has nothing to reach. */
function abstainNote(item: HabitTodayItem): string {
  if (item.statusToday === 'done') return 'انزلاق مسجَّل اليوم';
  if (item.statusToday === 'skip') return 'متخطّاة اليوم';
  if (item.statusToday === 'vacation') return 'إجازة اليوم';
  return isCleanToday(item) ? 'نظيف اليوم' : 'لا تسجيل اليوم';
}

/** One habit due today: the check mark, the title and progress, the outcome code, and the quick
 *  actions. An abstain habit has no check mark: its row says «نظيف اليوم», and one tap on
 *  «تسجيل انزلاق» logs the slip. */
export function HabitRow({ item, onTick, onValue, onSkip }: HabitRowProps) {
  const { habit } = item;
  const badge = habit.outcome ? <Badge>{habit.outcome}</Badge> : undefined;
  const skip = (
    <button type="button" class="habit-act habit-skip" aria-label={`تخطي ${habit.title_ar}`} onClick={onSkip}>
      تخطي
    </button>
  );

  if (polarityOf(habit) === 'abstain') {
    const clean = isCleanToday(item);
    return (
      <li class="habit-row habit-abstain" data-code={habit.code}>
        <div class="habit-abstain-body">
          <span class={clean ? 'habit-abstain-mark habit-abstain-clean' : 'habit-abstain-mark'} aria-hidden="true">
            <svg viewBox="0 0 24 24" focusable="false">
              {clean && <path d="M5.5 12.5l4.25 4.25L18.5 8" fill="none" stroke="currentColor" />}
            </svg>
          </span>
          <span class="check-text">
            <span class="check-label">{habit.title_ar}</span>
            <span class="check-note">{abstainNote(item)}</span>
          </span>
          {badge}
        </div>
        <div class="habit-actions">
          {item.statusToday !== 'done' && (
            <button type="button" class="habit-act habit-plus" aria-label={`تسجيل انزلاق: ${habit.title_ar}`} onClick={onTick}>
              تسجيل انزلاق
            </button>
          )}
          {skip}
        </div>
      </li>
    );
  }

  const quick = habit.kind === 'boolean' ? undefined : STEP[habit.unit];
  return (
    <li class="habit-row" data-code={habit.code}>
      <CheckRow
        checked={isDoneToday(item)}
        label={habit.title_ar}
        note={buildNote(item)}
        badge={badge}
        // A habit already done stays done: the correction is «تخطي», or «تراجع» while it is unsent.
        onToggle={(next) => next && onTick()}
      />
      <div class="habit-actions">
        {quick && (
          <button
            type="button"
            class="habit-act habit-plus"
            aria-label={`+${fmt.num(quick.step)} ${quick.noun} · ${habit.title_ar}`}
            onClick={() => onValue(nextDayValue(item.valueToday, quick.step))}
          >
            <bdi dir="ltr">+{fmt.num(quick.step)}</bdi>
          </button>
        )}
        {skip}
      </div>
    </li>
  );
}
