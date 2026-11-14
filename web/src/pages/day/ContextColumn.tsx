import type { Day } from '../../domain/types';
import { useGoals } from '../../goals/data';
import { cycleWords } from '../../goals/horizons';
import { daysWord } from '../../habits/days';
import { useMemory } from '../../settings/aiData';
import type { SettingsOut } from '../../settings/data';
import { Badge } from '../../ui/Badge';
import type { TodayOut } from './useDayData';

export interface ContextColumnProps {
  plan: TodayOut['plan'] | undefined;
  /** The day the page shows: the day of the cycle is said from the mirror's cycles. */
  day: Day;
  /** The settings of the person, or `undefined` until they are read. */
  settings: SettingsOut | undefined;
  /** What the reading of the settings is: an unread one is not «not set». */
  settingsState: 'loading' | 'ready' | 'error' | 'offline';
}

const REMINDERS = [
  { key: 'morning', label: 'الصباح' },
  { key: 'evening', label: 'المساء' },
  { key: 'weekly', label: 'المراجعة' },
] as const;

/** The times of the reminders the person set, and of the late notice when it is on. */
function reminderLines(settings: SettingsOut): string[] {
  const set = settings.day_reminders ?? {};
  const lines = REMINDERS.flatMap(({ key, label }) => {
    const reminder = set[key];
    return reminder == null ? [] : [`${label} ${reminder.time} · ${daysWord(reminder.days_mask)}`];
  });
  if (settings.late_notice_enabled) lines.push(`إشعار المتأخرات ${settings.late_notice_time}`);
  return lines;
}

/** «(…)» with a way to the settings: what only the person writes or sets, empty until then. */
function EmptyNote({ text }: { text: string }) {
  return (
    <>
      <p class="day-placeholder">{text}</p>
      <a class="day-context-link" href="/settings">
        الإعدادات
      </a>
    </>
  );
}

function Reminders({ settings, state }: { settings: SettingsOut | undefined; state: ContextColumnProps['settingsState'] }) {
  if (settings === undefined) return state === 'loading' ? null : <p class="day-placeholder">(تعذّرت قراءة الإعدادات)</p>;
  const lines = reminderLines(settings);
  if (lines.length === 0) return <EmptyNote text="(لم تُضبط بعد)" />;
  return (
    <ul class="day-reminders" aria-label="مواعيد التنبيه">
      {lines.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  );
}

/** The side column of the day: where the cycle stands, what only Abdullah writes (drawn empty between
 *  parentheses until he does), the lenses he set, and the times of the reminders. */
export function ContextColumn({ plan, day, settings, settingsState }: ContextColumnProps) {
  const goals = useGoals();
  const memory = useMemory();
  const cycle = plan?.cycle ?? null;
  const dayInCycle = plan?.day_in_cycle ?? null;
  const outcomes = plan?.focus_outcomes ?? [];
  const lenses = memory.items.filter((item) => item.kind === 'rule' && item.active);
  return (
    <aside class="day-context" aria-label="السياق">
      <section class="day-context-block" aria-labelledby="ctx-cycle">
        <h2 id="ctx-cycle" class="day-context-title">
          هدف الدورة
        </h2>
        {cycle === null ? (
          <p class="day-note">لا دورة جارية.</p>
        ) : (
          <p class="day-context-line">{cycleWords(cycle, dayInCycle, day, goals.data)}</p>
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
        {lenses.length > 0 ? (
          <ul class="day-rules" aria-label="العدسات المفعّلة">
            {lenses.map((lens) => (
              <li key={lens.id}>{lens.text}</li>
            ))}
          </ul>
        ) : (
          <EmptyNote text="(القواعد الدائمة)" />
        )}
      </section>
      <section class="day-context-block" aria-labelledby="ctx-reminders">
        <h2 id="ctx-reminders" class="day-context-title">
          مواعيد التنبيه
        </h2>
        <Reminders settings={settings} state={settingsState} />
      </section>
    </aside>
  );
}
