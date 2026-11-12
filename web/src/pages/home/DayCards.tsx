import type { components } from '../../api/schema';
import { fmt } from '../../lib/format';
import { Card } from '../../ui/Card';
import { LinkButton } from './LinkButton';

type JournalEntryOut = components['schemas']['JournalEntryOut'];

export interface DayCardsProps {
  /** Today's morning journal, if saved (or waiting in the outbox). */
  morning: JournalEntryOut | undefined;
  /** The evening journal is saved: the day is closed. */
  closed: boolean;
}

function plannedMinutes(entry: JournalEntryOut): number | null {
  const value = entry.answers.planned_minutes;
  return typeof value === 'number' ? value : null;
}

/**
 * The morning and evening cards with their state. The one prominent button of the page follows the
 * state of the day: «بدء يومية الصباح» until the morning is saved, then «إغلاق اليوم», then none.
 */
export function DayCards({ morning, closed }: DayCardsProps) {
  const planned = morning ? plannedMinutes(morning) : null;
  const morningStatus = morning
    ? planned !== null
      ? `حُفظت · ${fmt.count(planned, 'minute')} مقررة`
      : 'حُفظت'
    : 'لم تُحفظ بعد';
  return (
    <section class="day-entries" aria-labelledby="day-entries-title">
      <h2 id="day-entries-title" class="card-title">
        إدخالات اليوم
      </h2>
      <div class="day-cards">
        <Card title="الصباح" headingLevel={3} class="day-card">
          <p class="day-card-status">{morningStatus}</p>
          {morning ? (
            <LinkButton href="/day/morning">عرض يومية الصباح</LinkButton>
          ) : (
            <LinkButton href="/day/morning" variant="primary">
              بدء يومية الصباح
            </LinkButton>
          )}
        </Card>
        <Card title="المساء" headingLevel={3} class="day-card">
          <p class="day-card-status">{closed ? 'أُغلق اليوم' : 'لم يُغلق بعد'}</p>
          {closed ? (
            <LinkButton href="/day/evening">عرض إغلاق اليوم</LinkButton>
          ) : (
            <LinkButton href="/day/evening" variant={morning ? 'primary' : 'quiet'}>
              إغلاق اليوم
            </LinkButton>
          )}
        </Card>
      </div>
    </section>
  );
}
