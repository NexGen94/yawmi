import type { Feeling } from '../../breath/timing';
import { Button } from '../../ui/Button';

const CHOICES: readonly { value: Feeling; label: string }[] = [
  { value: 'calmer', label: 'أهدأ' },
  { value: 'same', label: 'كما كان' },
  { value: 'tense', label: 'أكثر توتراً' },
];

export interface SessionCheckinProps {
  /** One of the three, or `null` when the question is passed over. */
  onChoose(feeling: Feeling | null): void;
}

/** The one question after a session, with three answers and a way past it. It is a note for the
 *  person, not a measure of anything. */
export function SessionCheckin({ onChoose }: SessionCheckinProps) {
  return (
    <div class="checkin">
      <fieldset class="checkin-choices" aria-label="الشعور بعد الجلسة">
        {CHOICES.map((choice) => (
          <Button key={choice.value} onClick={() => onChoose(choice.value)}>
            {choice.label}
          </Button>
        ))}
      </fieldset>
      <Button class="checkin-skip" onClick={() => onChoose(null)}>
        تجاوز
      </Button>
    </div>
  );
}
