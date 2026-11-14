import { fmt } from '../../lib/format';
import { Segmented } from '../../ui/Segmented';
import { PRESET_MINUTES, type FocusPlanOut } from '../../focus/calc';

export interface PresetButtonsProps {
  /** The minutes now chosen. A plan with other minutes leaves the three unselected. */
  minutes: number;
  onMinutes(minutes: number): void;
  /** The favourite plans (`favorite` and active): each one starts a session with one tap. */
  favorites: FocusPlanOut[];
  onStartPlan(plan: FocusPlanOut): void;
}

const minutesLabel = (n: number): string => fmt.count(n, 'minute');

/** The three durations (a preference, not a rule) and the favourite combinations (design 4). */
export function PresetButtons({ minutes, onMinutes, favorites, onStartPlan }: PresetButtonsProps) {
  const options = PRESET_MINUTES.map((n) => ({ value: String(n), label: minutesLabel(n) }));
  const chosen = (PRESET_MINUTES as readonly number[]).includes(minutes) ? String(minutes) : '';
  return (
    <div class="focus-presets">
      <Segmented<string> label="المدة" options={options} value={chosen} onChange={(v) => onMinutes(Number(v))} />
      <p class="focus-note">المدد الثلاث تفضيل، لا قاعدة</p>
      {favorites.length > 0 && (
        <fieldset class="focus-favorites" aria-label="التركيبات المفضلة">
          {favorites.map((plan) => (
            <button key={plan.id} type="button" class="chip" onClick={() => onStartPlan(plan)}>
              <bdi>{plan.title_ar}</bdi>
              {` · ${minutesLabel(plan.minutes)}`}
            </button>
          ))}
        </fieldset>
      )}
    </div>
  );
}
