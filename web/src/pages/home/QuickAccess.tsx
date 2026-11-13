import { openAsk } from '../../ask/controller';
import type { FocusPlanOut } from '../../focus/today';
import { fmt } from '../../lib/format';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { LinkButton } from './LinkButton';

export interface QuickAccessProps {
  /** The plans marked as favourites: each is a link that opens the focus page on that plan. */
  favorites?: FocusPlanOut[];
}

/** Shortcuts to the next things: logging a habit, a habit from a goal, the favourite focus
 *  combinations, and a question. */
export function QuickAccess({ favorites = [] }: QuickAccessProps) {
  return (
    <Card title="وصول سريع" class="quick-access">
      <div class="quick-list">
        <LinkButton href="/habits">تسجيل عادة</LinkButton>
        <LinkButton href="/habits/new?source=goal">عادة من هدف</LinkButton>
        {favorites.map((plan) => (
          <LinkButton key={plan.id} href={`/focus?plan=${encodeURIComponent(plan.id)}`}>
            {`${plan.title_ar} · ${fmt.count(plan.minutes, 'minute')}`}
          </LinkButton>
        ))}
        <Button onClick={openAsk}>سؤال</Button>
      </div>
    </Card>
  );
}
