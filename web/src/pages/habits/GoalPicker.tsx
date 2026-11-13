import type { components } from '../../api/schema';
import { api } from '../../api/client';
import { unwrap } from '../../api/unwrap';
import { useQuery } from '../../data/query';
import { Badge } from '../../ui/Badge';
import { Skeleton } from '../../ui/Skeleton';
import { StateFrame } from '../../ui/StateFrame';

type Overview = components['schemas']['OverviewOut'];

export const OVERVIEW_KEY = 'habit-editor:overview';

export interface GoalPickerProps {
  /** The Notion page the form is linked to now, if any. */
  selected: string | null;
  /** A draft is on its way for this page. */
  busy: string | null;
  /** The person picked a milestone or a card: the page asks for its draft. */
  onPick(ref: string): void;
}

function PickerSkeleton() {
  return (
    <div class="goal-skeleton">
      <Skeleton blockSize="var(--hit)" />
      <Skeleton blockSize="var(--hit)" />
      <Skeleton blockSize="var(--hit)" />
    </div>
  );
}

/** The goals a habit can serve: each outcome by its next open milestone, and the cards, from
 *  `GET /v1/overview`. A pick is a milestone or a card page, the `ref` of `to-habit`. */
export function GoalPicker({ selected, busy, onPick }: GoalPickerProps) {
  const overview = useQuery<Overview>(OVERVIEW_KEY, async () => unwrap(await api.GET('/v1/overview')));
  const data = overview.data;
  const empty = data !== undefined && data.outcomes.length === 0 && data.cards.length === 0;

  const item = (ref: string, title: string, note: string | undefined, code?: string) => (
    <li key={ref}>
      <button
        type="button"
        class="goal-item"
        aria-pressed={selected === ref ? 'true' : 'false'}
        aria-busy={busy === ref ? 'true' : undefined}
        disabled={busy !== null}
        onClick={() => onPick(ref)}
      >
        <span class="goal-title">
          {code && <Badge>{code}</Badge>}
          <span>{title}</span>
        </span>
        {note && <span class="goal-note">{note}</span>}
      </button>
    </li>
  );

  return (
    <StateFrame
      state={overview.state}
      stale={overview.stale}
      empty={empty}
      emptyText="لا أهداف بعد؛ تظهر هنا حين تصل من الخطة."
      onRetry={overview.reload}
      skeleton={<PickerSkeleton />}
    >
      <ul class="goal-list" aria-label="الأهداف">
        {data?.outcomes.map((outcome) =>
          outcome.next_milestone ? (
            item(outcome.next_milestone.page_id, outcome.title, `المحطة: ${outcome.next_milestone.title}`, outcome.code)
          ) : (
            <li key={outcome.code} class="goal-item goal-off">
              <span class="goal-title">
                <Badge>{outcome.code}</Badge>
                <span>{outcome.title}</span>
              </span>
              <span class="goal-note">لا محطة مفتوحة</span>
            </li>
          ),
        )}
        {data?.cards.map((card) => item(card.page_id, card.title, 'بطاقة'))}
      </ul>
    </StateFrame>
  );
}
