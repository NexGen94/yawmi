import { fmt } from '../../lib/format';
import { Badge } from '../../ui/Badge';
import type { TodayOut } from './useDayData';

export interface ContextColumnProps {
  plan: TodayOut['plan'] | undefined;
}

/** The side column of the day: where the cycle stands, and what only Abdullah writes, drawn empty
 *  between parentheses until he does. The reminder times wait for the settings of task 10. */
export function ContextColumn({ plan }: ContextColumnProps) {
  const cycle = plan?.cycle ?? null;
  const dayInCycle = plan?.day_in_cycle ?? null;
  const outcomes = plan?.focus_outcomes ?? [];
  return (
    <aside class="day-context" aria-label="السياق">
      <section class="day-context-block" aria-labelledby="ctx-cycle">
        <h2 id="ctx-cycle" class="day-context-title">
          هدف الدورة
        </h2>
        {cycle === null ? (
          <p class="day-note">لا دورة جارية.</p>
        ) : (
          <p class="day-context-line">
            الدورة {fmt.num(cycle)}
            {dayInCycle !== null && ` · اليوم ${fmt.num(dayInCycle)}`}
          </p>
        )}
        {outcomes.length > 0 && (
          <ul class="day-outcomes" aria-label="مخرجات الدورة">
            {outcomes.map((code) => (
              <li key={code}>
                <Badge>
                  <bdi dir="ltr">{code}</bdi>
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section class="day-context-block" aria-labelledby="ctx-reason">
        <h2 id="ctx-reason" class="day-context-title">
          السبب العميق
        </h2>
        <p class="day-placeholder">(السبب العميق)</p>
      </section>
      <section class="day-context-block" aria-labelledby="ctx-rules">
        <h2 id="ctx-rules" class="day-context-title">
          القواعد الدائمة
        </h2>
        <p class="day-placeholder">(القواعد الدائمة)</p>
      </section>
      <section class="day-context-block" aria-labelledby="ctx-reminders">
        <h2 id="ctx-reminders" class="day-context-title">
          مواعيد التنبيه
        </h2>
        <p class="day-placeholder">(لم تُضبط بعد)</p>
      </section>
    </aside>
  );
}
