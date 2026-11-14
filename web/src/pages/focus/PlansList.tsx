import { useState } from 'preact/hooks';

import type { components } from '../../api/schema';
import { type FocusPlanOut, FOCUS_TEMPLATES } from '../../focus/calc';
import { fmt } from '../../lib/format';
import { OFFLINE_NOTE } from '../../lib/notes';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { Disclosure } from '../../ui/Disclosure';
import { type HabitChoice, PlanForm } from './PlanForm';
import { createPlan, patchPlan, type PlanResult } from './plans';

type FocusPlanIO = components['schemas']['FocusPlanIO'];

const minutesText = (n: number): string => fmt.count(n, 'minute');

const REASON: Record<'offline' | 'rejected', string> = {
  offline: OFFLINE_NOTE,
  rejected: 'لم تُقبل الخطة',
};

export interface PlanToolsProps {
  online: boolean;
  habits: HabitChoice[];
  goalRef: string | null;
  /** The plans were changed: read them again. */
  onChanged(): void;
}

/** What makes a plan: the ready templates (one tap each) and the form of a new one. Both are
 *  settings calls and need a connection. */
export function PlanTools({ online, habits, goalRef, onChanged }: PlanToolsProps) {
  const [note, setNote] = useState('');

  const save = async (plan: FocusPlanIO): Promise<string | null> => {
    const result = await createPlan(plan);
    if (result.ok) {
      setNote(`حُفظت الخطة: ${plan.title_ar}`);
      onChanged();
      return null;
    }
    return REASON[result.reason];
  };

  return (
    <div class="focus-tools">
      <fieldset class="focus-templates" aria-label="قوالب جاهزة">
        {FOCUS_TEMPLATES.map((t) => (
          <Button
            key={t.title}
            disabled={!online}
            onClick={() => {
              setNote('');
              void save({ title_ar: t.title, minutes: t.minutes, favorite: false, active: true }).then((failed) => {
                if (failed !== null) setNote(failed);
              });
            }}
          >
            {`${t.title} · ${minutesText(t.minutes)}`}
          </Button>
        ))}
      </fieldset>
      {!online && <p class="focus-note">{OFFLINE_NOTE}</p>}
      <Disclosure summary="خطة جديدة">
        <PlanForm online={online} habits={habits} goalRef={goalRef} onSave={save} />
      </Disclosure>
      <p class="focus-note" role="status">
        {note}
      </p>
    </div>
  );
}

export interface PlansListProps extends PlanToolsProps {
  plans: FocusPlanOut[];
  /** The plan now chosen for the next session. */
  chosenId: string | null;
  onChoose(plan: FocusPlanOut): void;
}

/** The plans of the person: each can be chosen for the next session, marked as a favourite (it then
 *  starts with one tap, and shows in the quick access of the home page) or stopped. */
export function PlansList(props: PlansListProps) {
  const { plans, chosenId, onChoose, online, onChanged } = props;
  const [note, setNote] = useState('');

  const change = (plan: FocusPlanOut, body: { favorite?: boolean; active?: boolean }): void => {
    setNote('');
    void patchPlan(plan.id, body).then((r: PlanResult) => {
      if (r.ok) onChanged();
      else setNote(REASON[r.reason]);
    });
  };

  return (
    <Card title="خطط التركيز" class="focus-plans" id="focus-plans">
      {plans.length === 0 ? (
        <p class="focus-note">لا خطط بعد</p>
      ) : (
        <ul class="focus-plan-list">
          {plans.map((plan) => (
            <li key={plan.id} class="focus-plan">
              <div class="focus-plan-text">
                <p class="focus-plan-title">
                  <bdi>{plan.title_ar}</bdi>
                </p>
                <p class="focus-note">{minutesText(plan.minutes)}</p>
              </div>
              <div class="focus-plan-actions">
                <Button
                  aria-pressed={plan.id === chosenId ? 'true' : 'false'}
                  aria-label={`اختيار ${plan.title_ar}`}
                  onClick={() => onChoose(plan)}
                >
                  اختيار
                </Button>
                <Button
                  aria-pressed={plan.favorite ? 'true' : 'false'}
                  aria-label={`تفضيل ${plan.title_ar}`}
                  disabled={!online}
                  onClick={() => change(plan, { favorite: !plan.favorite })}
                >
                  تفضيل
                </Button>
                <Button aria-label={`إيقاف ${plan.title_ar}`} disabled={!online} onClick={() => change(plan, { active: false })}>
                  إيقاف
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <p class="focus-note" role="status">
        {note}
      </p>
      <PlanTools online={online} habits={props.habits} goalRef={props.goalRef} onChanged={onChanged} />
    </Card>
  );
}

export interface StoppedPlansProps {
  plans: FocusPlanOut[];
  online: boolean;
  onChanged(): void;
}

/** The plans that were stopped, each with «تفعيل» (PATCH `active: true`). Nothing is ever deleted. */
export function StoppedPlans({ plans, online, onChanged }: StoppedPlansProps) {
  const [note, setNote] = useState('');
  if (plans.length === 0) return null;
  return (
    <Card title="الخطط الموقوفة" class="focus-plans">
      <ul class="focus-plan-list">
        {plans.map((plan) => (
          <li key={plan.id} class="focus-plan">
            <div class="focus-plan-text">
              <p class="focus-plan-title">
                  <bdi>{plan.title_ar}</bdi>
                </p>
              <p class="focus-note">{minutesText(plan.minutes)}</p>
            </div>
            <Button
              aria-label={`تفعيل ${plan.title_ar}`}
              disabled={!online}
              onClick={() => {
                setNote('');
                void patchPlan(plan.id, { active: true }).then((r: PlanResult) => {
                  if (r.ok) onChanged();
                  else setNote(REASON[r.reason]);
                });
              }}
            >
              تفعيل
            </Button>
          </li>
        ))}
      </ul>
      <p class="focus-note" role="status">
        {note}
      </p>
    </Card>
  );
}
