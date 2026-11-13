import { HOLD_MAX_SECONDS, HOLD_NOTE } from '../../breath/patterns';
import { fmt } from '../../lib/format';
import { Disclosure } from '../../ui/Disclosure';
import { TimedTest, type TimedTestProps } from './TimedTest';

export type HoldTestProps = Omit<TimedTestProps, 'kind' | 'startLabel' | 'stopLabel' | 'tail' | 'children'>;

/** «اختبار حبس النفس»: optional, closed until opened. It stops by itself at 30 seconds, the note that
 *  it can be stopped at any moment is above its button, and the result is a personal number to
 *  compare with the person's own earlier ones, not a mark and not a statement about health. */
export function HoldTest(props: HoldTestProps) {
  return (
    <div class="card breath-card">
      <Disclosure summary="اختبار اختياري">
        <h3 class="card-title">اختبار حبس النفس</h3>
        <p class="hold-note">{HOLD_NOTE}</p>
        <TimedTest {...props} kind="hold_test" startLabel="بدء الحبس" stopLabel="انتهاء الحبس" tail="رقم شخصي">
          <p class="breath-note">{`يتوقف القياس وحده عند ${fmt.count(HOLD_MAX_SECONDS, 'second')}.`}</p>
        </TimedTest>
      </Disclosure>
    </div>
  );
}
