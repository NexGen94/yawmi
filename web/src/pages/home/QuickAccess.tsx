import { openAsk } from '../../ask/controller';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { LinkButton } from './LinkButton';

/** Shortcuts to the next things: logging a habit, a habit from a goal, and a question. The favourite
 *  focus combinations join them when the focus page exists. */
export function QuickAccess() {
  return (
    <Card title="وصول سريع" class="quick-access">
      <div class="quick-list">
        <LinkButton href="/habits">تسجيل عادة</LinkButton>
        <LinkButton href="/habits/new?source=goal">عادة من هدف</LinkButton>
        <Button onClick={openAsk}>سؤال</Button>
      </div>
    </Card>
  );
}
