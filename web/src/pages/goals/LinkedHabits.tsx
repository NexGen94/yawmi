import { amount } from '../../habits/amount';
import { STEP } from '../../habits/HabitRow';
import { polarityOf, type HabitTodayItem } from '../../habits/useHabitsToday';
import { pctOrDash } from '../../goals/format';
import type { CardHabit } from '../../goals/types';
import { fmt } from '../../lib/format';

export interface LinkedHabitsProps {
  habits: CardHabit[];
  /** Today's habits with the outbox over them: the value of the day, and what can be logged. */
  items: HabitTodayItem[];
  /** The editor of habits on a draft for this goal; none: the goal cannot start one. */
  newHabitHref: string | undefined;
  onTick(code: string): void;
  onAdd(code: string, step: number): void;
}

/** A habit in force can be logged from here; an archived, ended or upcoming one cannot. */
const loggable = (item: HabitTodayItem): boolean => item.state !== 'archived' && item.state !== 'ended' && item.state !== 'upcoming';

function Action({ item, title, onTick, onAdd }: { item: HabitTodayItem; title: string; onTick(): void; onAdd(step: number): void }) {
  const { habit } = item;
  // An abstain habit is logged where its slip is, on the habits page; a habit out of force is not.
  if (polarityOf(habit) === 'abstain' || !loggable(item)) return null;
  if (habit.kind === 'boolean') {
    if (item.statusToday === 'done') return <span class="lh-done">سُجّلت اليوم</span>;
    return (
      <button type="button" class="lh-plus" aria-label={`تسجيل · ${title}`} onClick={onTick}>
        تسجيل
      </button>
    );
  }
  const quick = STEP[habit.unit];
  return (
    <button type="button" class="lh-plus" aria-label={`+${fmt.num(quick.step)} ${quick.noun} · ${title}`} onClick={() => onAdd(quick.step)}>
      <bdi dir="ltr">+{fmt.num(quick.step)}</bdi>
    </button>
  );
}

/** The habits that serve the goal, each with how steadily it is kept and its total repetitions (design
 *  4, features 6 and 12), and a «+» that logs it from here (design 13.1, ruling 13). */
export function LinkedHabits({ habits, items, newHabitHref, onTick, onAdd }: LinkedHabitsProps) {
  return (
    <>
      {habits.length === 0 ? (
        <p class="gd-none">لا عادات مرتبطة بهذا الهدف.</p>
      ) : (
        <ul class="lh-list">
          {habits.map((h) => {
            const item = items.find((i) => i.habit.code === h.code);
            const unit = item === undefined || item.habit.kind === 'boolean' ? '' : item.habit.unit;
            return (
              <li key={h.code} class="lh-row" data-habit={h.code}>
                <div class="lh-main">
                  <a href={`/habits/${encodeURIComponent(h.code)}`}>{h.title_ar}</a>
                  <span class="lh-meta">{`الالتزام ${pctOrDash(h.adherence)} · ${amount(h.total_done, '')}`}</span>
                  {item?.valueToday != null && <span class="lh-meta">{`اليوم ${amount(item.valueToday, unit)}`}</span>}
                </div>
                {item && <Action item={item} title={h.title_ar} onTick={() => onTick(h.code)} onAdd={(step) => onAdd(h.code, step)} />}
              </li>
            );
          })}
        </ul>
      )}
      {newHabitHref !== undefined && (
        <a class="btn btn-quiet lh-new" href={newHabitHref}>
          إضافة عادة
        </a>
      )}
    </>
  );
}
