// What a goal page is about. `/goals/:ref` takes an outcome code (O1), a card or a milestone (the
// page id of Notion): the tree and the table link to all three. This resolves the reference against
// the plan, and builds the link that starts a habit from it.

import type { CardFull, GoalOutcome, GoalsOut, MilestoneFull, PaceOut } from './types';

export type GoalTarget =
  | { kind: 'outcome'; ref: string; outcome: GoalOutcome; milestones: MilestoneFull[]; cards: CardFull[] }
  | { kind: 'card'; ref: string; card: CardFull; milestones: MilestoneFull[] }
  | { kind: 'milestone'; ref: string; milestone: MilestoneFull; outcome: GoalOutcome | undefined; cards: CardFull[] };

/** A reference to an outcome by its code (O1 to O12). */
export const isOutcomeRef = (ref: string): boolean => /^O\d+$/.test(ref);

/** The outcome, card or milestone `ref` names; `undefined` when the plan has none. */
export function resolveGoal(goals: GoalsOut, ref: string): GoalTarget | undefined {
  const outcome = goals.outcomes.find((o) => o.code === ref);
  if (outcome) {
    return {
      kind: 'outcome',
      ref,
      outcome,
      milestones: goals.milestones.filter((m) => m.outcome_code === ref),
      cards: goals.cards.filter((c) => c.outcome_codes.includes(ref)),
    };
  }
  const card = goals.cards.find((c) => c.page_id === ref);
  if (card) return { kind: 'card', ref, card, milestones: goals.milestones.filter((m) => m.card_page_ids.includes(ref)) };
  const milestone = goals.milestones.find((m) => m.page_id === ref);
  if (milestone) {
    return {
      kind: 'milestone',
      ref,
      milestone,
      outcome: goals.outcomes.find((o) => o.code === milestone.outcome_code),
      cards: goals.cards.filter((c) => milestone.card_page_ids.includes(c.page_id)),
    };
  }
  return undefined;
}

export function titleOf(target: GoalTarget): string {
  if (target.kind === 'outcome') return target.outcome.title;
  if (target.kind === 'card') return target.card.title;
  return target.milestone.title;
}

/** The milestones a goal page lists and edits. */
export function milestonesOf(target: GoalTarget): MilestoneFull[] {
  return target.kind === 'milestone' ? [target.milestone] : target.milestones;
}

/** The titles of the pages whose edits the log shows, by page id. */
export function titlesOf(target: GoalTarget): Map<string, string> {
  const titles = new Map<string, string>();
  for (const m of milestonesOf(target)) titles.set(m.page_id, m.title);
  if (target.kind === 'card') titles.set(target.card.page_id, target.card.title);
  if (target.kind === 'outcome') for (const c of target.cards) titles.set(c.page_id, c.title);
  return titles;
}

const KPI_PERIOD: Record<string, 'day' | 'week' | 'month'> = { daily: 'day', weekly: 'week', monthly: 'month' };

/** The editor of habits opened on a draft for this goal (task 12's link: `goal` is a milestone or a
 *  card page, `kpi` and `period` ask for a numeric target). An outcome starts from its next open
 *  milestone; none: `undefined`. The pace names the indicator the draft follows, when it has one. */
export function habitHref(target: GoalTarget, pace: PaceOut | null | undefined): string | undefined {
  const goal =
    target.kind === 'outcome'
      ? target.outcome.next_milestone?.page_id
      : target.kind === 'card'
        ? target.card.page_id
        : target.milestone.page_id;
  if (!goal) return undefined;
  const query = new URLSearchParams({ goal });
  if (target.kind === 'outcome' && pace?.kpi_code) {
    const frequency = target.outcome.kpis.find((k) => k.code === pace.kpi_code)?.frequency ?? '';
    query.set('kpi', pace.kpi_code);
    query.set('period', KPI_PERIOD[frequency] ?? 'week');
  }
  return `/habits/new?${query.toString()}`;
}
