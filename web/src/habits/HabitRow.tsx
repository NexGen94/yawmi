import type { ComponentChildren } from 'preact';

import { CheckRow } from '../ui/CheckRow';
import { Badge } from '../ui/Badge';
import { fmt, type Noun } from '../lib/format';
import { isCleanToday, isDoneToday, polarityOf, roundUpNeed, type HabitTodayItem } from './useHabitsToday';
import type { HabitUnit } from './types';
import './habit-row.css';

export interface HabitRowProps {
  item: HabitTodayItem;
  /** The check mark: logs the habit done (a count or duration: today's share). */
  onTick(): void;
  /** The «+5» button: adds `step` to the day's value. The page adds to the latest value, so two
   *  quick taps add up; the row never sends a total it computed from its own render. */
  onAdd(step: number): void;
  /** A tap on a row that is already done: takes the log back if it is unsent, else says so. */
  onUntick(): void;
  onSkip(): void;
  /** The habits page: also says what the state is («تحقق هدف الفترة») and flags a late habit. */
  showState?: boolean;
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

const DONE_UNSENT = 'التسجيل لم يُرسل بعد؛ النقر يتراجع عنه';
const DONE_SENT = 'التسجيل مُرسل؛ التصحيح بتخطي اليوم';

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
    parts.push(`المطلوب${NBSP}يومياً:${NBSP}${amount(roundUpNeed(progress.needPerDay, unit), unit).replace(' ', NBSP)}`);
  }
  return parts.join(' · ');
}

/** A habit that is not in force today has no actions: the row only says why. */
function staticNote(item: HabitTodayItem): string {
  switch (item.state) {
    case 'archived':
      return 'مؤرشفة';
    case 'upcoming':
      return `تبدأ في ${item.habit.start_day}`;
    case 'ended':
      return 'انتهت مدتها';
    default:
      return 'غير مجدولة اليوم';
  }
}

/** Whether the habit can be logged today: in force, and scheduled today. */
function loggableToday(item: HabitTodayItem): boolean {
  return item.dueToday && item.state !== 'archived' && item.state !== 'upcoming' && item.state !== 'ended';
}

/** The identity sentence (design 4, feature 11), on its own line under the title. */
function withIdentity(item: HabitTodayItem, text: string | undefined): ComponentChildren | undefined {
  const identity = item.habit.identity_text;
  if (!identity) return text;
  return (
    <>
      <span class="habit-identity">{identity}</span>
      {text}
    </>
  );
}

function badgesOf(item: HabitTodayItem, showState: boolean): ComponentChildren | undefined {
  const outcome = item.habit.outcome ? <Badge>{item.habit.outcome}</Badge> : null;
  const late = showState && item.state === 'late' ? <Badge tone="signal">متأخرة</Badge> : null;
  if (!outcome && !late) return undefined;
  return (
    <>
      {late}
      {outcome}
    </>
  );
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
export function HabitRow({ item, onTick, onAdd, onUntick, onSkip, showState = false }: HabitRowProps) {
  const { habit } = item;
  const badge = badgesOf(item, showState);
  const skip = (
    <button type="button" class="habit-act habit-skip" aria-label={`تخطي ${habit.title_ar}`} onClick={onSkip}>
      تخطي
    </button>
  );

  const body = (note: ComponentChildren | undefined, markClass: string) => (
    <div class="habit-abstain-body">
      <span class={markClass} aria-hidden="true" />
      <span class="check-text">
        <span class="check-label">{habit.title_ar}</span>
        {habit.identity_text && <span class="check-note habit-identity">{habit.identity_text}</span>}
        {note && <span class="check-note">{note}</span>}
      </span>
      {badge}
    </div>
  );

  if (!loggableToday(item)) {
    return (
      <li class="habit-row habit-static" data-code={habit.code}>
        {body(staticNote(item), 'habit-abstain-mark')}
      </li>
    );
  }

  if (polarityOf(habit) === 'abstain') {
    const clean = isCleanToday(item);
    return (
      <li class="habit-row habit-abstain" data-code={habit.code}>
        {body(abstainNote(item), clean ? 'habit-abstain-mark habit-abstain-clean' : 'habit-abstain-mark')}
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
  const progressNote = [showState && item.state === 'done' ? 'تحقق هدف الفترة' : undefined, buildNote(item)]
    .filter(Boolean)
    .join(' · ');
  return (
    <li class="habit-row" data-code={habit.code}>
      <CheckRow
        checked={isDoneToday(item)}
        label={habit.title_ar}
        note={withIdentity(item, progressNote || undefined)}
        badge={badge}
        hint={isDoneToday(item) ? (item.unsent ? DONE_UNSENT : DONE_SENT) : undefined}
        // A tap on a done row never does nothing: it takes an unsent log back, else it says so.
        onToggle={(next) => (next ? onTick() : onUntick())}
      />
      <div class="habit-actions">
        {quick && (
          <button
            type="button"
            class="habit-act habit-plus"
            aria-label={`+${fmt.num(quick.step)} ${quick.noun} · ${habit.title_ar}`}
            onClick={() => onAdd(quick.step)}
          >
            <bdi dir="ltr">+{fmt.num(quick.step)}</bdi>
          </button>
        )}
        {skip}
      </div>
    </li>
  );
}
