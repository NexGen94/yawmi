import { useState } from 'preact/hooks';

import { Plant } from '../../charts/Plant';
import { Ring } from '../../charts/Ring';
import { type FocusPlanOut, plantStage } from '../../focus/calc';
import { clockText, elapsedMinutes, elapsedSeconds, phase } from '../../focus/timer';
import { fmt } from '../../lib/format';
import { Button } from '../../ui/Button';
import { Field } from '../../ui/Field';
import { HeroCard } from '../../ui/HeroCard';
import { Segmented } from '../../ui/Segmented';
import { Skeleton } from '../../ui/Skeleton';
import { PresetButtons } from './PresetButtons';
import { EXTEND_MINUTES, minutesText, OVERFLOW_OFFER_MINUTES, type UseFocusSession } from './useSession';

/** What the person has chosen before starting. */
export interface Selection {
  minutes: number;
  plan: FocusPlanOut | null;
  goalRef: string | null;
}

export interface SessionTimerProps {
  focus: UseFocusSession;
  plans: FocusPlanOut[];
  selection: Selection;
  /** The title of the linked goal, when the plan of the goals knows it. */
  goalTitle: string | null;
  onMinutes(minutes: number): void;
  onClearPlan(): void;
  onClearGoal(): void;
}

const RATINGS = [1, 2, 3, 4, 5];

function GoalLine({ goalRef, title, onClear }: { goalRef: string | null; title: string | null; onClear?: () => void }) {
  if (goalRef === null) return null;
  return (
    <p class="focus-line">
      <span>الهدف المرتبط{title ? `: ${title}` : ''}</span>
      {onClear && (
        <button type="button" class="focus-link" onClick={onClear}>
          إزالة الربط
        </button>
      )}
    </p>
  );
}

function Idle({ focus, plans, selection, goalTitle, onMinutes, onClearPlan, onClearGoal }: SessionTimerProps) {
  const { minutes, plan, goalRef } = selection;
  const favorites = plans.filter((p) => p.favorite && p.active);
  const startPlan = (p: FocusPlanOut): void => {
    void focus.start({ minutes: p.minutes, goalRef: p.goal_ref, habitCode: p.habit_code, planId: p.id });
  };
  const saved = focus.saved;
  return (
    <div class="focus-idle">
      <div role="status" class="focus-saved">
        {saved && (
          <>
            <p>{`حُفظت الجلسة: ${minutesText(saved.minutes)} من ${minutesText(saved.planned)}`}</p>
            <p>{`النبتة بلغت المرحلة ${fmt.num(saved.stage)} من ${fmt.num(4)}`}</p>
            {saved.habit && <p>{saved.habit}</p>}
          </>
        )}
      </div>
      {plan && (
        <p class="focus-line">
          <span>{`${plan.title_ar} · ${minutesText(plan.minutes)}`}</span>
          <button type="button" class="focus-link" onClick={onClearPlan}>
            إزالة الخطة
          </button>
        </p>
      )}
      <GoalLine goalRef={goalRef} title={goalTitle} onClear={onClearGoal} />
      <PresetButtons minutes={minutes} onMinutes={onMinutes} favorites={favorites} onStartPlan={startPlan} />
      <div class="focus-actions">
        <Button
          variant="primary"
          onClick={() =>
            void focus.start({ minutes, goalRef, habitCode: plan?.habit_code ?? null, planId: plan?.id ?? null })
          }
        >
          بدء
        </Button>
      </div>
    </div>
  );
}

function Active({ focus, plans, goalTitle }: SessionTimerProps) {
  const { session, now } = focus;
  if (session === null) return null;
  const plan = session.planId ? plans.find((p) => p.id === session.planId) : undefined;
  const planned = session.plannedMinutes;
  const current = phase(session, now);
  const seconds = elapsedSeconds(session, now);
  const clock = current === 'running' ? clockText(planned * 60 - seconds) : `+${clockText(seconds - planned * 60)}`;
  const minutes = elapsedMinutes(session, now);
  const stage = plantStage(minutes, planned);
  return (
    <div class="focus-active" data-phase={current}>
      <div class="focus-visual">
        <Ring value={minutes / planned} label="تقدّم الجلسة" size={120} />
        <div class="focus-figures">
          <p class="focus-name">{plan?.title_ar ?? 'جلسة تركيز'}</p>
          <p class="focus-clock" role="timer" aria-label="الوقت" data-phase={current}>
            {clock}
          </p>
          <p class="focus-sub">
            {current === 'running' ? `من ${minutesText(planned)}` : 'انتهى الوقت المقرر، والعدّاد يواصل الصعود'}
          </p>
        </div>
        <div class="focus-plant">
          <Plant stage={stage} />
          <p class="focus-sub">{`المرحلة ${fmt.num(stage)} من ${fmt.num(4)}`}</p>
        </div>
      </div>
      <GoalLine goalRef={session.goalRef ?? null} title={goalTitle} />
      <p class="visually-hidden" role="status">
        {current === 'overflow' ? 'انتهى الوقت المقرر' : ''}
      </p>
      <div class="focus-actions">
        <Button variant="primary" onClick={() => void focus.beginEnding()}>
          إنهاء
        </Button>
        {current === 'overflow' && (
          <>
            <Button onClick={() => void focus.extend()}>تمديد</Button>
            <span class="focus-note">{`التمديد يضيف ${minutesText(EXTEND_MINUTES)}`}</span>
          </>
        )}
      </div>
    </div>
  );
}

function Wrapup({ focus }: Pick<SessionTimerProps, 'focus'>) {
  const [rating, setRating] = useState('');
  const [step, setStep] = useState('');
  const { session, endedAt } = focus;
  if (session === null || endedAt === null) return null;
  const end = new Date(Math.max(endedAt.getTime(), Date.parse(session.startedAt)));
  const elapsed = elapsedMinutes(session, end);
  const recorded = Math.round(elapsed);
  const stage = plantStage(elapsed, session.plannedMinutes);
  const pastPlanned = elapsed - session.plannedMinutes > OVERFLOW_OFFER_MINUTES;
  const wrapup = () => ({ rating: rating === '' ? null : Number(rating), nextStep: step });
  return (
    <div class="focus-wrapup">
      <div class="focus-visual">
        <div class="focus-figures">
          <p class="focus-name">انتهت الجلسة</p>
          <p class="focus-sub focus-result">{`${minutesText(recorded)} من ${minutesText(session.plannedMinutes)}`}</p>
        </div>
        <div class="focus-plant">
          <Plant stage={stage} />
          <p class="focus-sub">{`المرحلة ${fmt.num(stage)} من ${fmt.num(4)}`}</p>
        </div>
      </div>
      <Segmented<string>
        label="تقييم التركيز"
        options={RATINGS.map((n) => ({ value: String(n), label: fmt.num(n) }))}
        value={rating}
        onChange={setRating}
      />
      <p class="focus-note">{`من ${fmt.num(1)} (أقل تركيزاً) إلى ${fmt.num(5)} (أكثر تركيزاً)`}</p>
      <Field label="الخطوة التالية" value={step} onInput={setStep} maxLength={500} />
      <div class="focus-actions">
        <Button variant="primary" onClick={() => void focus.save(wrapup())}>
          حفظ الجلسة
        </Button>
        {pastPlanned && <Button onClick={() => void focus.save(wrapup(), { atPlanned: true })}>حفظ بالمدة المقررة</Button>}
        <Button onClick={() => void focus.discard()}>تجاهل الجلسة</Button>
      </div>
      {pastPlanned && (
        <p class="focus-note">
          {`مضى أكثر من ${minutesText(OVERFLOW_OFFER_MINUTES)} على الوقت المقرر: يمكن حفظ الجلسة بالمدة المقررة`}
        </p>
      )}
    </div>
  );
}

/** «تجاهل الجلسة» pressed: the session is still on the device until the window ends. */
function Discarded({ focus }: Pick<SessionTimerProps, 'focus'>) {
  return (
    <div class="focus-idle">
      <p class="focus-name" role="status">
        أُلغيت الجلسة
      </p>
      <div class="focus-actions">
        <Button variant="primary" onClick={() => focus.undoDiscard()}>
          تراجع
        </Button>
      </div>
    </div>
  );
}

/** The surface of the session (ink): choosing, the running counter with its ring and plant, and the
 *  wrap-up. It never waits for the network. */
export function SessionTimer(props: SessionTimerProps) {
  const { focus } = props;
  let body;
  if (!focus.ready) body = <Skeleton blockSize="120px" />;
  else if (focus.session === null) body = <Idle {...props} />;
  else if (focus.endedAt !== null && focus.discarding) body = <Discarded focus={focus} />;
  else if (focus.endedAt !== null) body = <Wrapup focus={focus} />;
  else body = <Active {...props} />;
  return (
    <HeroCard title="جلسة التركيز" class="focus-hero">
      {body}
    </HeroCard>
  );
}
