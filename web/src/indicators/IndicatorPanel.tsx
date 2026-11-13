// The indicator card of a page with its dialog. The dialog is a separate chunk, fetched the first
// time it is opened (design 9.3: it does not enter the first bundle), and is kept once loaded.

import type { ComponentType } from 'preact';
import { useState } from 'preact/hooks';

import type { GoalIndicatorValue } from '../goals/types';
import type { HabitOut } from '../habits/types';
import type { IndicatorView } from '../progress/indicator';
import { IndicatorCard } from './IndicatorCard';
import type { IndicatorDialogProps } from './IndicatorDialog';
import type { IndicatorDisplay, IndicatorIO } from './types';

export interface IndicatorPanelProps {
  subject: { kind: 'habit' | 'goal'; ref: string; title: string };
  view: IndicatorView;
  display: IndicatorDisplay;
  online: boolean;
  /** For a habit subject. */
  habit?: HabitOut;
  /** For a goal subject: what the server computed. */
  goal?: GoalIndicatorValue;
  /** The stored indicator of the subject, when it has one. */
  config?: IndicatorIO;
  /** A write the page must show was made. */
  onChanged(): void;
}

export function IndicatorPanel({ subject, view, display, online, habit, goal, config, onChanged }: IndicatorPanelProps) {
  const [open, setOpen] = useState(false);
  const [Dialog, setDialog] = useState<ComponentType<IndicatorDialogProps> | null>(null);
  const [failed, setFailed] = useState(false);

  const show = (): void => {
    setFailed(false);
    setOpen(true);
    if (Dialog !== null) return;
    void import('./IndicatorDialog')
      .then((module) => setDialog(() => module.default))
      .catch(() => {
        setOpen(false);
        setFailed(true);
      });
  };

  return (
    <>
      <IndicatorCard subject={subject} value={view} display={display} onCustomize={show} />
      {failed && (
        <p class="indicator-error" role="alert">
          تعذّر التحميل؛ يمكن المحاولة ثانية
        </p>
      )}
      {Dialog !== null && (
        <Dialog
          open={open}
          onClose={() => setOpen(false)}
          onChanged={onChanged}
          subject={subject}
          habit={habit}
          goal={goal}
          config={config}
          online={online}
        />
      )}
    </>
  );
}
