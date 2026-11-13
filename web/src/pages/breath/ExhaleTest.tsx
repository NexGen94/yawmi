import { EXHALE_MAX_SECONDS } from '../../breath/patterns';
import { fmt } from '../../lib/format';
import { Card } from '../../ui/Card';
import { TimedTest, type TimedTestProps } from './TimedTest';

export type ExhaleTestProps = Omit<TimedTestProps, 'kind' | 'startLabel' | 'stopLabel' | 'tail' | 'children'>;

/** «اختبار طول الزفير»: one slow exhale, measured by two taps, compared with the mean of the earlier
 *  ones. It stops by itself at 60 seconds. */
export function ExhaleTest(props: ExhaleTestProps) {
  return (
    <Card title="اختبار طول الزفير" class="breath-card">
      <TimedTest {...props} kind="exhale_test" startLabel="بدء الزفير" stopLabel="انتهاء الزفير">
        <p class="breath-note">{`تُقاس مدة زفير واحد بطيء بنقرتين: الأولى عند بدئه والثانية عند انتهائه. يتوقف القياس وحده عند ${fmt.count(EXHALE_MAX_SECONDS, 'second')}.`}</p>
      </TimedTest>
    </Card>
  );
}
