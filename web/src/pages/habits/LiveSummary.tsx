import type { ComponentChildren } from 'preact';

import type { HabitForm } from '../../habits/form';
import { needLines, spanLines } from '../../habits/summary';
import { Card } from '../../ui/Card';

export interface LiveSummaryProps {
  form: HabitForm;
  today: string;
  /** The save button and what stands beside it. */
  children?: ComponentChildren;
}

/** The habit as it will be saved, in sentences that follow the form: when it starts and ends, what it
 *  asks for each day, week or month. */
export function LiveSummary({ form, today, children }: LiveSummaryProps) {
  return (
    <Card title="ملخص العادة" class="editor-summary">
      <ul class="summary-lines">
        {form.outcome && <li>{`يخدم المخرج ${form.outcome}`}</li>}
        {[...spanLines(form, today), ...needLines(form)].map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      {children}
    </Card>
  );
}
