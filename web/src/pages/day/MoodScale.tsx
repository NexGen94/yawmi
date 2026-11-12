import { fmt } from '../../lib/format';
import { Segmented } from '../../ui/Segmented';

export interface MoodScaleProps {
  /** 1 to 5, or null before a choice. */
  value: number | null;
  onChange(score: number): void;
}

const SCORES = [1, 2, 3, 4, 5] as const;

/** Five steps, one tap. The numeral is the name of each step; the ends say what they mean. */
export function MoodScale({ value, onChange }: MoodScaleProps) {
  return (
    <div class="mood-scale">
      <Segmented
        label="المزاج"
        options={SCORES.map((n) => ({ value: String(n), label: fmt.num(n) }))}
        value={value === null ? '' : String(value)}
        onChange={(v) => onChange(Number(v))}
      />
      <p class="mood-ends" aria-hidden="true">
        <span>الأدنى</span>
        <span>الأعلى</span>
      </p>
    </div>
  );
}
