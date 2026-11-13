import { focusScore } from '../../focus/calc';
import { NO_TARGET, scoreDetail } from '../../focus/format';
import { fmt } from '../../lib/format';
import { Card } from '../../ui/Card';

export interface FocusScoreProps {
  /** Minutes of focus today, the outbox included. */
  minutes: number;
  /** The planned minutes of the morning, else the daily setting, else null. */
  target: number | null;
}

/** The score of the day (design 9.5): one big number, and what it stands for. With no target there
 *  is no number to show, and the card says why; the minutes are shown either way. */
export function FocusScore({ minutes, target }: FocusScoreProps) {
  const score = focusScore(minutes, target);
  return (
    <Card title="درجة التركيز" class="focus-score">
      {score !== null && target !== null ? (
        <>
          <p class="focus-score-num">{fmt.num(score)}</p>
          <p class="focus-score-line">{scoreDetail(minutes, target)}</p>
        </>
      ) : (
        <>
          <p class="focus-score-line">{minutes > 0 ? `${fmt.count(minutes, 'minute')} اليوم` : 'لا دقائق تركيز اليوم'}</p>
          <p class="focus-score-note">{`${NO_TARGET}: يُحدَّد من الدقائق المقررة في يومية الصباح`}</p>
        </>
      )}
    </Card>
  );
}
