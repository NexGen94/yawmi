// The client check of an AI reply (design section 10): the server already holds a reply to these
// limits, so this is the second look. A reply that breaks one is not shown; the screen says
// «تعذّر التحليل اليوم» and the day is not blocked by it.

import type { components } from '../api/schema';

export type GroundedInsight = components['schemas']['GroundedInsight'];
export type DeeperOut = components['schemas']['DeeperOut'];

/** What a screen says in place of a reply it cannot show. */
export const UNAVAILABLE_TEXT = 'تعذّر التحليل اليوم';

/** The two fixed lines the server gives for every kind of request (`yawmi.ai.service`). They are
 *  valid replies, shown as they are. */
export const OUT_OF_SCOPE_LINE = 'هذا خارج نطاق المتابعة اليومية، والمختص هو المرجع المناسب.';
export const NO_DATA_LINE = 'لا بيانات كافية.';
export const REFUSAL_LINES = { out_of_scope: OUT_OF_SCOPE_LINE, no_data: NO_DATA_LINE } as const;

/** A line, and a question, may hold 200 characters; an alternative question 80 (design 10). */
export const LINE_MAX = 200;
export const QUESTION_MAX = 200;
export const OPTION_MAX = 80;
export const OPTIONS_MAX = 3;

export interface AcceptOptions {
  /** The reply is a stored row: one saved before task 18 may name sources without their cards, and
   *  then its words still show (the card is simply not drawn). A fresh reply always has its cards. */
  cardsOptional?: boolean;
}

const oneLine = (text: string): boolean => text.length <= LINE_MAX && !/[\r\n]/.test(text);

/** `r` itself when it may be shown, else null: more than `maxLines` lines, a line or a question
 *  over its limit or with a new line in it, or (unless `cardsOptional`) a cited source without its card. */
export function acceptInsight<T extends GroundedInsight>(r: T, maxLines: 1 | 2, options: AcceptOptions = {}): T | null {
  if (r.lines.length > maxLines || !r.lines.every(oneLine)) return null;
  if (r.question !== null && r.question !== undefined && (r.question.length > QUESTION_MAX || /[\r\n]/.test(r.question))) return null;
  if (!options.cardsOptional) {
    const known = new Set((r.cards ?? []).map((c) => c.source_id));
    const cited = [...r.source_ids, ...r.priorities.map((p) => p.source_id)];
    if (cited.some((id) => !known.has(id))) return null;
  }
  return r;
}

/** The same look at a go-deeper reply: a question and up to three alternatives within their limits. */
export function acceptDeeper(d: DeeperOut): DeeperOut | null {
  if (d.question !== null && (d.question.length > QUESTION_MAX || /[\r\n]/.test(d.question))) return null;
  if (d.options.length > OPTIONS_MAX) return null;
  if (d.options.some((o) => o.title.length > OPTION_MAX || /[\r\n]/.test(o.title))) return null;
  return d;
}
