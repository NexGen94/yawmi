// «تخصيص المؤشر»: what a habit or a goal measures, against what, over which period, how it is drawn,
// and its reminder. Loaded when it is first opened (`IndicatorPanel`), so it is not in the first
// bundle. Every write is a settings call and needs the network.

import { useState } from 'preact/hooks';

import { api } from '../api/client';
import type { GoalIndicatorValue } from '../goals/types';
import { fromHabit, toHabitPatch } from '../habits/form';
import type { HabitOut, ReminderIn } from '../habits/types';
import { isAbortOrTimeout } from '../lib/timeout';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Field } from '../ui/Field';
import { type Option, Segmented } from '../ui/Segmented';
import { deleteIndicator, putIndicator, WRITE_TIMEOUT_MS } from './data';
import { OFFLINE_NOTE, RemindersSection } from './RemindersSection';
import type { IndicatorDisplay, IndicatorIO, IndicatorMeasure, IndicatorPeriod, IndicatorSource } from './types';
import './indicators.css';

const MEASURES: readonly Option<IndicatorMeasure>[] = [
  { value: 'completion', label: 'نسبة الإنجاز' },
  { value: 'total', label: 'المجموع' },
  { value: 'avg_7d', label: 'متوسط 7 أيام' },
  { value: 'avg_30d', label: 'متوسط 30 يوماً' },
  { value: 'strength', label: 'درجة القوة' },
];
const PERIODS: readonly Option<IndicatorPeriod>[] = [
  { value: 'day', label: 'اليوم' },
  { value: 'week', label: 'الأسبوع' },
  { value: 'month', label: 'الشهر' },
  { value: 'cycle', label: 'الدورة' },
  { value: 'all', label: 'الكل' },
];
const DISPLAYS: readonly Option<IndicatorDisplay>[] = [
  { value: 'ring', label: 'حلقة' },
  { value: 'bar', label: 'شريط' },
  { value: 'number', label: 'رقم' },
  { value: 'sparkline', label: 'خط بياني' },
];
const SOURCES: readonly Option<Exclude<IndicatorSource, 'habit_logs'>>[] = [
  { value: 'milestones', label: 'المحطات' },
  { value: 'linked_habits', label: 'العادات المرتبطة' },
  { value: 'tasks', label: 'المهام' },
];

const MAX_TARGET = 100_000;
const SAVE_FAILED = 'تعذّر الحفظ؛ يمكن المحاولة ثانية';

export interface IndicatorDialogProps {
  open: boolean;
  onClose(): void;
  /** Called after a write the page must show (the indicator saved or reset, a reminder added). */
  onChanged(): void;
  subject: { kind: 'habit' | 'goal'; ref: string; title: string };
  /** The habit itself, for a habit subject: its reminders are its own. */
  habit?: HabitOut;
  /** What the server computed for a goal subject: the source and display it is shown with now. */
  goal?: GoalIndicatorValue;
  /** The stored indicator of the subject, when it has one. */
  config?: IndicatorIO;
  online: boolean;
}

/** The target as typed: empty is no target, otherwise a positive number. */
function parseTarget(text: string): { value: number | null } | { error: string } {
  const trimmed = text.trim();
  if (trimmed === '') return { value: null };
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0 || n > MAX_TARGET) return { error: 'المستهدف عدد موجب.' };
  return { value: n };
}

export default function IndicatorDialog(props: IndicatorDialogProps) {
  // The form lives only while the dialog is open: each opening starts from what is stored now.
  if (!props.open) return null;
  return <OpenDialog {...props} />;
}

function OpenDialog({ onClose, onChanged, subject, habit, goal, config, online }: IndicatorDialogProps) {
  const isHabit = subject.kind === 'habit';
  const [measure, setMeasure] = useState<IndicatorMeasure>(config?.measure ?? 'completion');
  const [period, setPeriod] = useState<IndicatorPeriod>(config?.period ?? (isHabit ? (habit?.period ?? 'week') : 'all'));
  const [source, setSource] = useState<Exclude<IndicatorSource, 'habit_logs'>>(
    config && config.source !== 'habit_logs' ? config.source : (goal?.source ?? 'milestones'),
  );
  const [display, setDisplay] = useState<IndicatorDisplay>(config?.display ?? goal?.display ?? 'ring');
  const [targetText, setTargetText] = useState(config?.target == null ? '' : String(config.target));
  const [error, setError] = useState<string | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  const stored = config !== undefined || goal?.custom === true;
  const wantsTarget = isHabit ? measure === 'total' || measure === 'avg_7d' || measure === 'avg_30d' : source !== 'linked_habits';
  const disabled = !online || busy;

  const body = (reminder: IndicatorIO['reminder']): IndicatorIO | undefined => {
    const target = wantsTarget ? parseTarget(targetText) : { value: null };
    if ('error' in target) {
      setError(target.error);
      return undefined;
    }
    setError(undefined);
    return isHabit
      ? { subject_kind: 'habit', subject_ref: subject.ref, source: 'habit_logs', measure, target: target.value, period, display }
      : {
          subject_kind: 'goal',
          subject_ref: subject.ref,
          source,
          measure: 'completion',
          target: target.value,
          period: 'all',
          display,
          reminder: reminder ?? null,
        };
  };

  const finish = async (write: () => Promise<boolean>): Promise<void> => {
    setBusy(true);
    setFailed(false);
    const ok = await write();
    setBusy(false);
    if (ok) {
      onChanged();
      onClose();
    } else {
      setFailed(true);
    }
  };

  const save = (): Promise<void> | undefined => {
    const next = body(config?.reminder);
    return next === undefined ? undefined : finish(() => putIndicator(next));
  };

  /** A reminder list saved where it lives: the habit for a habit, the indicator for a goal. */
  const saveReminders = async (reminders: ReminderIn[]): Promise<boolean> => {
    let ok: boolean;
    if (isHabit) {
      if (habit === undefined) return false;
      const patch = toHabitPatch(habit, { ...fromHabit(habit), reminders });
      if (Object.keys(patch).length === 0) return true;
      ok = await patchHabit(habit.code, patch);
    } else {
      // The goal's indicator carries its reminder: the rest of it goes as it is shown now.
      const next = body(reminders[0] ?? null);
      if (next === undefined) return false;
      ok = await putIndicator(next);
    }
    if (ok) onChanged();
    return ok;
  };

  return (
    <Dialog
      open
      title="تخصيص المؤشر"
      onClose={onClose}
      actions={
        <>
          <Button variant="primary" disabled={disabled} onClick={() => void save()}>
            حفظ
          </Button>
          <Button disabled={disabled || !stored} onClick={() => void finish(() => deleteIndicator(subject.kind, subject.ref))}>
            إعادة إلى الافتراض
          </Button>
          {!online && <span class="indicator-hint">{OFFLINE_NOTE}</span>}
        </>
      }
    >
      <div class="indicator-dialog-form">
        {isHabit ? (
          <div class="indicator-group">
            <p class="indicator-group-title" aria-hidden="true">
              القياس
            </p>
            <Segmented label="القياس" options={MEASURES} value={measure} onChange={(v) => setMeasure(v)} />
          </div>
        ) : (
          <div class="indicator-group">
            <p class="indicator-group-title" aria-hidden="true">
              المصدر
            </p>
            <Segmented label="المصدر" options={SOURCES} value={source} onChange={(v) => setSource(v)} />
          </div>
        )}
        {isHabit && measure === 'total' && (
          <div class="indicator-group">
            <p class="indicator-group-title" aria-hidden="true">
              الفترة
            </p>
            <Segmented label="الفترة" options={PERIODS} value={period} onChange={(v) => setPeriod(v)} />
          </div>
        )}
        {wantsTarget && (
          <Field label="المستهدف" type="number" value={targetText} onInput={setTargetText} hint="اختياري" error={error} />
        )}
        <div class="indicator-group">
          <p class="indicator-group-title" aria-hidden="true">
            العرض
          </p>
          <Segmented label="العرض" options={DISPLAYS} value={display} onChange={(v) => setDisplay(v)} />
        </div>
        {failed && (
          <p class="indicator-error" role="alert">
            {SAVE_FAILED}
          </p>
        )}
        <RemindersSection
          kind={subject.kind}
          reminders={isHabit ? (habit?.reminders ?? []) : config?.reminder ? [config.reminder] : []}
          online={online}
          onSave={saveReminders}
        />
      </div>
    </Dialog>
  );
}

/** `PATCH /v1/habits/{code}` with only the reminders changed. */
async function patchHabit(code: string, patch: ReturnType<typeof toHabitPatch>): Promise<boolean> {
  try {
    const result = await api.PATCH('/v1/habits/{code}', {
      params: { path: { code } },
      body: patch,
      signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
    });
    return result.response.ok;
  } catch (error: unknown) {
    if (error instanceof TypeError || isAbortOrTimeout(error)) return false;
    throw error;
  }
}
