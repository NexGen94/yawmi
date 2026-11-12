import type { Day } from '../../domain/types';
import { toOrdinal } from '../../domain/days';
import { relativeDays } from '../../goals/due';
import { Code } from '../../goals/Code';
import { DASH, pctOrDash } from '../../goals/format';
import { Iso } from '../../goals/Iso';
import type { GoalOutcome, GoalsOut, MilestoneFull } from '../../goals/types';
import { fmt } from '../../lib/format';
import { Badge } from '../../ui/Badge';
import { Disclosure } from '../../ui/Disclosure';

const byDate = (a: MilestoneFull, b: MilestoneFull): number => {
  if (a.due_date === b.due_date) return 0;
  if (a.due_date === null) return 1;
  if (b.due_date === null) return -1;
  return a.due_date.localeCompare(b.due_date);
};

function MilestoneRow({ m, today }: { m: MilestoneFull; today: Day }) {
  const late = !m.done && m.due_date !== null && toOrdinal(m.due_date) < toOrdinal(today);
  return (
    <li class="tree-row">
      <a href={`/goals/${encodeURIComponent(m.page_id)}`}>{m.title}</a>
      <span class="tree-meta">
        <span>{m.done ? 'منجزة' : 'مفتوحة'}</span>
        <span>{m.due_date === null ? DASH : fmt.day(m.due_date)}</span>
        {late && m.due_date !== null && <Badge tone="signal">{relativeDays(toOrdinal(m.due_date) - toOrdinal(today))}</Badge>}
      </span>
    </li>
  );
}

function Outcome({ outcome, goals, today }: { outcome: GoalOutcome; goals: GoalsOut; today: Day }) {
  const milestones = goals.milestones.filter((m) => m.outcome_code === outcome.code).sort(byDate);
  const cards = goals.cards.filter((c) => c.outcome_codes.includes(outcome.code));
  const head = (
    <>
      <span class="tree-head">
        <Badge>
          <Code code={outcome.code} />
        </Badge>
        <span class="tree-title">
          <Iso text={outcome.title} />
        </span>
        <span class="tree-pct">{pctOrDash(outcome.completion)}</span>
      </span>
      <span class="tree-acceptance">
        <Iso text={outcome.acceptance} />
      </span>
    </>
  );
  return (
    <li class="tree-outcome" data-outcome={outcome.code}>
      <Disclosure summary={head}>
        <p class="tree-link">
          <a href={`/goals/${encodeURIComponent(outcome.code)}`}>تفاصيل المخرج</a>
        </p>
        <h4 class="tree-sub">العادات الداعمة</h4>
        {outcome.habits.length === 0 ? (
          <p class="tree-none">لا عادات مرتبطة بهذا المخرج.</p>
        ) : (
          <ul class="tree-list">
            {outcome.habits.map((h) => (
              <li key={h.code} class="tree-row">
                <a href={`/habits/${encodeURIComponent(h.code)}`}>{h.title_ar}</a>
                <span class="tree-meta">
                  <span>{`الالتزام ${pctOrDash(h.adherence)}`}</span>
                  <span>{fmt.count(h.total_done, 'time')}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
        <h4 class="tree-sub">المحطات</h4>
        {milestones.length === 0 ? (
          <p class="tree-none">لا محطات لهذا المخرج.</p>
        ) : (
          <ul class="tree-list">
            {milestones.map((m) => (
              <MilestoneRow key={m.page_id} m={m} today={today} />
            ))}
          </ul>
        )}
        <h4 class="tree-sub">البطاقات</h4>
        {cards.length === 0 ? (
          <p class="tree-none">لا بطاقات لهذا المخرج.</p>
        ) : (
          <ul class="tree-list">
            {cards.map((c) => (
              <li key={c.page_id} class="tree-row">
                <a href={`/goals/${encodeURIComponent(c.page_id)}`}>{c.title}</a>
                <span class="tree-meta">
                  <span>{c.status ?? DASH}</span>
                  <span>{c.target_date === null ? DASH : fmt.day(c.target_date)}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Disclosure>
    </li>
  );
}

/** The outcomes of the plan, each with its title and acceptance in the head and, when opened, its
 *  supporting habits, then its milestones and cards. Read only. */
export function OutcomeTree({ goals, today }: { goals: GoalsOut; today: Day }) {
  return (
    <ol class="tree">
      {goals.outcomes.map((outcome) => (
        <Outcome key={outcome.code} outcome={outcome} goals={goals} today={today} />
      ))}
    </ol>
  );
}
