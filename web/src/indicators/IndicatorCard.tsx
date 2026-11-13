import { ProgressBar } from '../charts/ProgressBar';
import { Ring } from '../charts/Ring';
import { ratio as clamp, ratioPct } from '../charts/scale';
import { Sparkline } from '../charts/Sparkline';
import type { IndicatorView } from '../progress/indicator';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import type { IndicatorDisplay } from './types';
import './indicators.css';

export interface IndicatorCardProps {
  subject: { kind: 'habit' | 'goal'; ref: string; title: string };
  value: IndicatorView;
  display: IndicatorDisplay;
  /** Opens the dialog that sets what is measured, and adds a reminder (design 9.3: no indicator
   *  without a way to a reminder). */
  onCustomize(): void;
}

/** The progress indicator of a habit or a goal: one big number, drawn as a ring, a bar, the number
 *  alone or a sparkline. With nothing to measure it says so with a dash and the reason, never 0%. */
export function IndicatorCard({ subject, value, display, onCustomize }: IndicatorCardProps) {
  const label = `مؤشر ${subject.title}`;
  const ratio = value.completion;
  // A ring or a bar needs a ratio, a sparkline a series: without one the number stands alone.
  const hasSeries = value.series !== undefined && value.series.length > 1;
  const shape = display === 'sparkline' && !hasSeries ? 'number' : display;
  const drawn = (shape === 'ring' || shape === 'bar') && ratio === null ? 'number' : shape;
  // The ring writes its own percentage in the middle: the text beside it only says what it adds
  // (a total, an average, «أقل من 1%»), and is left out when it would repeat the ring.
  const repeatsRing = drawn === 'ring' && ratio !== null && value.text === ratioPct(clamp(ratio));
  return (
    <Card title="المؤشر" class="indicator-card">
      <div class={`indicator-body indicator-${drawn}`}>
        {drawn === 'ring' && ratio !== null && <Ring value={ratio} label={label} size={96} figure={repeatsRing} />}
        <div class="indicator-figures">
          {!repeatsRing && <p class="indicator-text">{value.text}</p>}
          {value.reason !== undefined && <p class="indicator-reason">{value.reason}</p>}
        </div>
      </div>
      {drawn === 'bar' && ratio !== null && <ProgressBar value={ratio} label={label} />}
      {drawn === 'sparkline' && value.series && <Sparkline values={value.series} label={label} />}
      <div class="indicator-actions">
        <Button onClick={onCustomize}>تخصيص وإضافة تذكير</Button>
      </div>
    </Card>
  );
}
