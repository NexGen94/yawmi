import { useState } from 'preact/hooks';

import { ALL_DAYS, maskOf, namesOf, WEEKDAYS } from '../../habits/days';
import type { ReminderIn } from '../../habits/types';
import { reminderError } from '../../indicators/RemindersSection';
import type { SettingsOut, SettingsPatch } from '../../settings/data';
import { OFFLINE_NOTE, SaveNote, useSaving } from '../../settings/saving';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { Chips } from '../../ui/Chips';
import { Disclosure } from '../../ui/Disclosure';
import { Field } from '../../ui/Field';

type Key = 'morning' | 'evening' | 'weekly';
type DayReminders = NonNullable<SettingsOut['day_reminders']>;

/** The weekly review is on the last day of the plan's week, Saturday (bit 6), unless the person picks another. */
const DEFAULT_MASK: Record<Key, number> = { morning: ALL_DAYS, evening: ALL_DAYS, weekly: 0b1000000 };
const LABEL: Record<Key, string> = { morning: 'الصباح', evening: 'المساء', weekly: 'المراجعة' };
const DAY_OPTIONS = WEEKDAYS.map((name) => ({ value: name, label: name }));

function daysWord(mask: number): string {
  if (mask === ALL_DAYS) return 'كل يوم';
  return namesOf(mask).join('، ') || 'لا يوم';
}

interface RowProps {
  which: Key;
  value: ReminderIn | null | undefined;
  disabled: boolean;
  /** Saves the reminder (`null`: no reminder at that time of day); true when the server took it. */
  onSave(next: ReminderIn | null): Promise<boolean>;
}

/** One of the three reminders of the day: a time and the days, saved on their own. */
function DayReminderRow({ which, value, disabled, onSave }: RowProps) {
  const word = LABEL[which];
  const [time, setTime] = useState(value?.time ?? '');
  const [mask, setMask] = useState(value?.days_mask ?? DEFAULT_MASK[which]);
  const [error, setError] = useState<string | undefined>(undefined);
  const saving = useSaving();
  const changed = time !== (value?.time ?? '') || mask !== (value?.days_mask ?? DEFAULT_MASK[which]);

  const save = async (): Promise<void> => {
    const next = { time, days_mask: mask };
    const problem = reminderError(next);
    setError(problem);
    if (problem === undefined) await saving.run(() => onSave(next));
  };
  const stop = async (): Promise<void> => {
    if (await saving.run(() => onSave(null))) {
      setTime('');
      setMask(DEFAULT_MASK[which]);
    }
  };

  return (
    <div class="settings-reminder">
      <Field
        label={`وقت تذكير ${word}`}
        type="time"
        value={time}
        error={error}
        onInput={(next) => {
          saving.reset();
          setError(undefined);
          setTime(next);
        }}
      />
      <Disclosure summary={`الأيام: ${daysWord(mask)}`}>
        <Chips
          label={`أيام تذكير ${word}`}
          options={DAY_OPTIONS}
          selected={namesOf(mask)}
          onChange={(names) => {
            saving.reset();
            setMask(maskOf(names));
          }}
        />
      </Disclosure>
      <div class="settings-actions">
        <Button disabled={disabled || saving.busy || !changed || time === ''} onClick={() => void save()}>
          {`حفظ تذكير ${word}`}
        </Button>
        {value != null && (
          <Button disabled={disabled || saving.busy} onClick={() => void stop()}>
            {`إيقاف تذكير ${word}`}
          </Button>
        )}
      </div>
      <SaveNote status={saving.status} />
    </div>
  );
}

/** Whether the browser lets this app show notifications. The late notice is a push: it does nothing
 *  until they are enabled. */
function notificationsEnabled(): boolean {
  return typeof Notification !== 'undefined' && Notification.permission === 'granted';
}

function LateNotice({ settings, online, onSave }: DayRemindersSectionProps) {
  const [time, setTime] = useState(settings.late_notice_time);
  const saving = useSaving();
  const toggling = useSaving();
  const disabled = !online;
  return (
    <div class="settings-late">
      <label class="settings-switch">
        <input
          type="checkbox"
          role="switch"
          checked={settings.late_notice_enabled}
          disabled={disabled || toggling.busy}
          onChange={(event) => {
            const next = event.currentTarget.checked;
            void toggling.run(() => onSave({ late_notice_enabled: next }));
          }}
        />
        <span>إشعار يومي بالمتأخرات</span>
      </label>
      <p class="settings-note">إشعار واحد في اليوم يلخّص ما تأخر، ما دام فيه متأخر.</p>
      {!notificationsEnabled() && <p class="settings-note">يعمل بعد تفعيل الإشعارات</p>}
      <Field
        label="وقت إشعار المتأخرات"
        type="time"
        value={time}
        onInput={(next) => {
          saving.reset();
          setTime(next);
        }}
      />
      <div class="settings-actions">
        <Button
          disabled={disabled || saving.busy || time === settings.late_notice_time || time === ''}
          onClick={() => void saving.run(() => onSave({ late_notice_time: time }))}
        >
          حفظ وقت الإشعار
        </Button>
      </div>
      <SaveNote status={saving.status} />
      <SaveNote status={toggling.status} />
    </div>
  );
}

export interface DayRemindersSectionProps {
  settings: SettingsOut;
  online: boolean;
  onSave(patch: SettingsPatch): Promise<boolean>;
}

/** The reminders of the morning, the evening and the weekly review, and the daily notice of what is
 *  late (design 16 and A2). A nested `day_reminders` replaces the stored one whole, so the three
 *  keys are always sent together. */
export function DayRemindersSection({ settings, online, onSave }: DayRemindersSectionProps) {
  const current: DayReminders = settings.day_reminders ?? {};
  const saveOne = (which: Key) => (next: ReminderIn | null) =>
    onSave({
      day_reminders: {
        morning: current.morning ?? null,
        evening: current.evening ?? null,
        weekly: current.weekly ?? null,
        [which]: next,
      },
    });
  return (
    <Card title="تذكيرات اليوم والمتأخرات" class="settings-card">
      {(['morning', 'evening', 'weekly'] as const).map((which) => (
        <DayReminderRow key={which} which={which} value={current[which]} disabled={!online} onSave={saveOne(which)} />
      ))}
      {!online && <p class="settings-hint">{OFFLINE_NOTE}</p>}
      <LateNotice settings={settings} online={online} onSave={onSave} />
    </Card>
  );
}
