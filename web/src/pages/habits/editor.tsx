import { useLocation } from 'preact-iso';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';

import { useQuery } from '../../data/query';
import { DRAFT_FAILED, requestDraft } from '../../habits/draft';
import { type EditorData, editorQueryKey, loadEditorData } from '../../habits/editorData';
import {
  emptyForm,
  type FormErrors,
  fromDraft,
  fromHabit,
  type HabitForm,
  type HabitType,
  habitType,
  lockedFields,
  validate,
  withType,
} from '../../habits/form';
import { FAILED_MESSAGE, OFFLINE_MESSAGE, saveHabit, TIMEOUT_MESSAGE } from '../../habits/save';
import type { HabitAnchor, HabitPeriod, HabitUnit } from '../../habits/types';
import { todayRiyadh } from '../../lib/today';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { Field } from '../../ui/Field';
import { Segmented } from '../../ui/Segmented';
import { Skeleton } from '../../ui/Skeleton';
import { StateFrame } from '../../ui/StateFrame';
import { DateRangeFields } from './DateRangeFields';
import { GoalPicker } from './GoalPicker';
import { IdentityField } from './IdentityField';
import { LiveSummary } from './LiveSummary';
import { LockedGroup } from './LockedGroup';
import { ReminderFields } from './ReminderFields';
import { ScheduleFields } from './ScheduleFields';
import './habits.css';

const SYSTEM_HINT = 'عادة نظامية من الخطة';
const POLARITY_LOCKED_HINT = 'لا يمكن تغيير نوع العادة بعد تسجيلها';
const ABSTAIN_HINT = 'عادة الامتناع يومية بنعم أو لا وهدفها 1';
const AVERAGE_HINT = 'المتوسط عدّ يومي';
const INDICATOR_FAILED = 'العادة محفوظة، وتعذّر حفظ المؤشر؛ يمكن المحاولة ثانية بالحفظ.';

const TYPES: readonly { value: HabitType; label: string }[] = [
  { value: 'yesno', label: 'نعم أو لا' },
  { value: 'count', label: 'عدد' },
  { value: 'duration', label: 'مدة' },
  { value: 'average', label: 'متوسط' },
  { value: 'abstain', label: 'امتناع' },
];
/** The polarity a type has: only «امتناع» is abstain, the other four build. */
const polarityOfType = (type: HabitType): 'build' | 'abstain' => (type === 'abstain' ? 'abstain' : 'build');

/** The draft over the form, keeping what the person already touched. */
function mergeUntouched(current: HabitForm, draft: HabitForm, touched: ReadonlySet<keyof HabitForm>): HabitForm {
  const merged: HabitForm = { ...draft };
  for (const key of touched) (merged as Record<keyof HabitForm, unknown>)[key] = current[key];
  return merged;
}

const PERIODS: readonly { value: HabitPeriod; label: string }[] = [
  { value: 'day', label: 'يومية' },
  { value: 'week', label: 'أسبوعية' },
  { value: 'month', label: 'شهرية' },
];
const COUNT_UNITS: readonly { value: HabitUnit; label: string }[] = [
  { value: '', label: 'بلا وحدة' },
  { value: 'session', label: 'جلسة' },
];
const DURATION_UNITS: readonly { value: HabitUnit; label: string }[] = [
  { value: 'min', label: 'دقيقة' },
  { value: 'hour', label: 'ساعة' },
];
const ANCHORS: readonly { value: HabitAnchor; label: string }[] = [
  { value: 'after_wake', label: 'بعد الاستيقاظ' },
  { value: 'free', label: 'خلال اليوم' },
  { value: 'before_sleep', label: 'قبل النوم' },
];
const SOURCES = [
  { value: 'free', label: 'حرة' },
  { value: 'goal', label: 'من هدف' },
] as const;

/** Whether the browser says it has a connection; follows the `online` and `offline` events. */
function useOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  useEffect(() => {
    const up = (): void => setOnline(true);
    const down = (): void => setOnline(false);
    addEventListener('online', up);
    addEventListener('offline', down);
    return () => {
      removeEventListener('online', up);
      removeEventListener('offline', down);
    };
  }, []);
  return online;
}

interface EditorFormProps {
  initial: HabitForm;
  /** The stored habit being edited; absent for a new one. */
  data?: EditorData;
  /** A draft to ask for on opening: the page was reached from a goal. */
  prefill?: { goal: string; kpi: string | null; period: HabitPeriod } | null;
  /** The page was reached with no goal named (`?source=goal`, the home page): it opens on «من هدف», where the goal is chosen. */
  chooseGoal?: boolean;
  notice?: string;
}

function EditorForm({ initial, data, prefill, chooseGoal, notice }: EditorFormProps) {
  const location = useLocation();
  const today = todayRiyadh();
  const online = useOnline();
  const original = data?.habit;

  const [form, setForm] = useState<HabitForm>(initial);
  const [targetText, setTargetText] = useState(String(initial.target_per_period));
  const [source, setSource] = useState<'free' | 'goal'>(initial.goal_ref !== null || prefill || chooseGoal ? 'goal' : 'free');
  const [attempted, setAttempted] = useState(false);
  const [serverErrors, setServerErrors] = useState<FormErrors>({});
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [drafting, setDrafting] = useState<string | null>(null);
  const [draftMessage, setDraftMessage] = useState<string | null>(null);
  const [polarityLocked, setPolarityLocked] = useState(data?.hasLogs ?? false);

  // The fields the person changed: a draft that comes late fills the others and leaves these.
  const touched = useRef(new Set<keyof HabitForm>());
  const touch = (before: HabitForm, after: HabitForm): void => {
    for (const key of Object.keys(after) as (keyof HabitForm)[]) {
      if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) touched.current.add(key);
    }
  };

  const change = (next: HabitForm): void => {
    touch(form, next);
    setForm(next);
    setServerErrors({});
    if (next.target_per_period !== Number(targetText)) setTargetText(String(next.target_per_period));
  };

  // A draft asked for by the link (the goal page): the form fills when it comes.
  useEffect(() => {
    if (!prefill) return;
    let cancelled = false;
    setDrafting(prefill.goal);
    void requestDraft(prefill.goal, { kpi: prefill.kpi, period: prefill.period }).then((result) => {
      if (cancelled) return;
      setDrafting(null);
      if (result.ok) {
        const draft = fromDraft(result.draft, prefill.kpi);
        setForm((current) => {
          const next = mergeUntouched(current, draft, touched.current);
          setTargetText(String(next.target_per_period));
          return next;
        });
      } else {
        setDraftMessage(DRAFT_FAILED);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [prefill]);

  const pick = async (ref: string): Promise<void> => {
    setDrafting(ref);
    setDraftMessage(null);
    const result = await requestDraft(ref);
    setDrafting(null);
    if (!result.ok) {
      setDraftMessage(DRAFT_FAILED);
      return;
    }
    const next = fromDraft(result.draft);
    setForm(next);
    setTargetText(String(next.target_per_period));
    setServerErrors({});
  };

  const chooseSource = (next: 'free' | 'goal'): void => {
    setSource(next);
    setDraftMessage(null);
    if (next === 'free' && form.goal_ref !== null) change({ ...form, goal_ref: null, outcome: null, ac_ref: null });
  };

  const locked = lockedFields(form);
  const system = form.system;
  const type = habitType(form);
  // Only the polarity is fixed once a habit has a log (the server refuses nothing else): the types
  // that would flip it are off, the others stay. A system habit's type is off whole.
  const typeLocked = system;
  const typeOptions = TYPES.map((option) => ({
    ...option,
    disabled: polarityLocked && polarityOfType(option.value) !== (original?.polarity ?? 'build'),
  }));
  const hintFor = (field: keyof HabitForm): string | undefined => {
    // A system habit says it once, at the top of the form, not under every locked field.
    if (system) return undefined;
    if (form.polarity === 'abstain' && locked.has(field)) return ABSTAIN_HINT;
    if (form.measure === 'average' && locked.has(field)) return AVERAGE_HINT;
    return undefined;
  };

  const errors: FormErrors = useMemo(
    () => ({ ...(attempted ? validate(form, today) : {}), ...serverErrors }),
    [attempted, form, today, serverErrors],
  );

  const save = async (): Promise<void> => {
    setAttempted(true);
    setMessage(null);
    setServerErrors({});
    setSaving(true);
    const result = await saveHabit(form, original, { hadAverage: data?.hadAverage ?? false });
    setSaving(false);
    if (result.ok) {
      const base = `/habits/${encodeURIComponent(result.habit.code)}`;
      location.route(result.indicator === 'failed' ? `${base}/edit?indicator=failed` : base);
      return;
    }
    switch (result.kind) {
      case 'validation':
        setServerErrors(result.errors ?? {});
        break;
      case 'offline':
        setMessage(OFFLINE_MESSAGE);
        break;
      case 'timeout':
        setMessage(TIMEOUT_MESSAGE);
        break;
      case 'failed':
        setMessage(FAILED_MESSAGE);
        break;
      case 'locked':
        if (result.errors?.polarity !== undefined) {
          // A log came in since the page opened: the type goes back to what it was when the page
          // opened (an average stays an average), the flip stays blocked, and the person is told
          // beside the button that nothing was saved.
          setPolarityLocked(true);
          setForm((f) => withType(f, habitType(initial)));
          setMessage(`${result.errors.polarity}؛ أُعيد النوع ولم يُحفظ شيء بعد.`);
        } else {
          setServerErrors(result.errors ?? {});
          setMessage(result.errors?.system ?? FAILED_MESSAGE);
        }
        break;
    }
  };

  const unitOptions = form.kind === 'duration' ? DURATION_UNITS : COUNT_UNITS;
  const showUnit = form.kind !== 'boolean' && form.measure !== 'average';

  return (
    <div class="page-cols editor-cols">
      <div class="editor-main">
        <Card title="العادة" class="editor-card">
          {system && (
            <p class="editor-lock-note">
              <strong>{SYSTEM_HINT}</strong> <span>يُعدَّل المرسى والتذكيرات وجملة الهوية فقط.</span>
            </p>
          )}
          {original === undefined ? (
            <>
              <LockedGroup label="المصدر">
                <Segmented label="المصدر" options={SOURCES} value={source} onChange={chooseSource} />
              </LockedGroup>
              {source === 'goal' && (
                <div class="editor-goals">
                  <GoalPicker selected={form.goal_ref} busy={drafting} onPick={(ref) => void pick(ref)} />
                  {draftMessage && (
                    <p class="field-error" role="alert">
                      {draftMessage}
                    </p>
                  )}
                </div>
              )}
            </>
          ) : (
            form.goal_ref !== null && <p class="editor-source">{`مرتبطة بهدف في الخطة${form.outcome ? ` · ${form.outcome}` : ''}`}</p>
          )}
          <Field
            label="العنوان"
            value={form.title_ar}
            onInput={(title_ar) => change({ ...form, title_ar })}
            error={errors.title_ar}
            hint={locked.has('title_ar') ? hintFor('title_ar') : undefined}
            disabled={locked.has('title_ar')}
            maxLength={200}
            required
          />
          <LockedGroup
            label="النوع"
            locked={typeLocked || polarityLocked}
            hint={system ? undefined : POLARITY_LOCKED_HINT}
            error={errors.kind ?? errors.polarity}
          >
            <Segmented
              label="النوع"
              options={typeOptions}
              value={type}
              disabled={typeLocked}
              onChange={(next) => change(withType(form, next))}
            />
          </LockedGroup>
          {showUnit && (
            <LockedGroup label="الوحدة" locked={locked.has('unit')} hint={hintFor('unit')} error={errors.unit}>
              <Segmented
                label="الوحدة"
                options={unitOptions}
                value={form.unit}
                disabled={locked.has('unit')}
                onChange={(unit) => change({ ...form, unit })}
              />
            </LockedGroup>
          )}
          <Field
            label="الهدف في الفترة"
            type="number"
            min={0}
            step="any"
            value={targetText}
            onInput={(text) => {
              setTargetText(text);
              setServerErrors({});
              touched.current.add('target_per_period');
              setForm({ ...form, target_per_period: text === '' ? Number.NaN : Number(text) });
            }}
            error={errors.target_per_period}
            hint={locked.has('target_per_period') ? hintFor('target_per_period') : undefined}
            disabled={locked.has('target_per_period')}
          />
          <LockedGroup label="الفترة" locked={locked.has('period')} hint={hintFor('period')}>
            <Segmented
              label="الفترة"
              options={PERIODS}
              value={form.period}
              disabled={locked.has('period')}
              onChange={(period) => change({ ...form, period, target_per_period: periodTarget(form, period) })}
            />
          </LockedGroup>
          <ScheduleFields
            form={form}
            errors={errors}
            locked={locked.has('schedule_kind')}
            lockHint={hintFor('schedule_kind')}
            onChange={change}
          />
        </Card>
        <Card title="الفترة والإشارة" class="editor-card">
          <DateRangeFields
            form={form}
            errors={errors}
            locked={locked.has('start_day')}
            lockHint={hintFor('start_day')}
            onChange={change}
          />
          <LockedGroup label="الإشارة">
            <Segmented
              label="الإشارة"
              options={ANCHORS}
              value={form.anchor}
              onChange={(anchor) => change({ ...form, anchor })}
            />
          </LockedGroup>
        </Card>
        <Card title="الهوية والتذكيرات" class="editor-card">
          <IdentityField value={form.identity_text} error={errors.identity_text} onInput={(identity_text) => change({ ...form, identity_text })} />
          <ReminderFields reminders={form.reminders} error={errors.reminders} onChange={(reminders) => change({ ...form, reminders })} />
        </Card>
      </div>
      <div class="editor-side">
        <LiveSummary form={form} today={today}>
          {notice && (
            <p class="editor-notice" role="status">
              {notice}
            </p>
          )}
          <div class="editor-save">
            <Button variant="primary" disabled={!online || saving} onClick={() => void save()}>
              حفظ العادة
            </Button>
            {!online && <span class="editor-offline">{OFFLINE_MESSAGE}</span>}
          </div>
          {message && (
            <p class="field-error" role="alert">
              {message}
            </p>
          )}
        </LiveSummary>
      </div>
    </div>
  );
}

/** A yes/no target must fit inside its period; other kinds keep theirs. */
function periodTarget(form: HabitForm, period: HabitPeriod): number {
  if (form.kind !== 'boolean') return form.target_per_period;
  const cap = period === 'day' ? 1 : period === 'week' ? 7 : 28;
  return Math.min(cap, form.target_per_period);
}

function EditorSkeleton() {
  return (
    <div class="page-cols editor-cols">
      <div class="editor-main">
        <div class="card">
          <Skeleton blockSize="var(--fs-section)" inlineSize="30%" />
          <Skeleton blockSize="var(--hit)" />
          <Skeleton blockSize="var(--hit)" />
          <Skeleton blockSize="var(--hit)" />
        </div>
      </div>
      <div class="editor-side">
        <div class="card">
          <Skeleton blockSize="var(--fs-section)" inlineSize="40%" />
          <Skeleton />
          <Skeleton inlineSize="70%" />
        </div>
      </div>
    </div>
  );
}

function NewHabit() {
  const location = useLocation();
  const query = location.query ?? {};
  const goal = query.goal ?? '';
  const kpi = query.kpi ?? null;
  const period = (['day', 'week', 'month'] as const).find((p) => p === query.period) ?? 'week';
  const prefill = useMemo(() => (goal === '' ? null : { goal, kpi, period }), [goal, kpi, period]);
  const initial = useMemo(() => emptyForm(todayRiyadh()), []);
  return (
    <>
      <h1>عادة جديدة</h1>
      <EditorForm key={goal} initial={initial} prefill={prefill} chooseGoal={query.source === 'goal'} />
    </>
  );
}

function EditHabit({ code }: { code: string }) {
  const location = useLocation();
  const today = todayRiyadh();
  const loaded = useQuery<EditorData | null>(editorQueryKey(code), () => loadEditorData(code, today));
  const indicatorFailed = location.query?.indicator === 'failed';
  const data = loaded.data;
  return (
    <>
      <h1>تعديل العادة</h1>
      <StateFrame
        state={loaded.state}
        stale={loaded.stale}
        empty={data === null}
        emptyText="لا توجد عادة بهذا الرمز."
        emptyAction={
          <a class="btn btn-quiet" href="/habits">
            العادات
          </a>
        }
        onRetry={loaded.reload}
        skeleton={<EditorSkeleton />}
      >
        {data && (
          <EditorForm
            key={code}
            initial={{ ...fromHabit(data.habit), measure: data.hadAverage || indicatorFailed ? 'average' : 'target' }}
            data={data}
            notice={indicatorFailed ? INDICATOR_FAILED : undefined}
          />
        )}
      </StateFrame>
    </>
  );
}

export interface HabitEditorProps {
  /** Filled in by the router from `/habits/:code/edit`; absent on `/habits/new`. */
  params?: { code?: string };
}

export default function HabitEditorPage({ params }: HabitEditorProps) {
  const code = params?.code;
  return code === undefined ? <NewHabit /> : <EditHabit code={code} />;
}
