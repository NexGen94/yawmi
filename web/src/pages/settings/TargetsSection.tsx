import { useState } from 'preact/hooks';

import type { SettingsOut, SettingsPatch } from '../../settings/data';
import { OFFLINE_NOTE, SaveNote, useSaving } from '../../settings/saving';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { Field } from '../../ui/Field';

/** The limits of `focus_daily_target_min` and `breath_weekly_target_min` (design 7.3). */
export const MIN_TARGET = 5;
export const MAX_TARGET = 600;

const TARGET_ERROR = `الهدف عدد صحيح من ${MIN_TARGET} إلى ${MAX_TARGET} دقيقة`;

type TargetKey = 'focus_daily_target_min' | 'breath_weekly_target_min';

/** `''` is «no target» (`null`); anything else must be a whole number from 5 to 600. `undefined` is
 *  what a refused text gives. */
function parseTarget(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  if (!/^\d+$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return value >= MIN_TARGET && value <= MAX_TARGET ? value : undefined;
}

export interface TargetsSectionProps {
  settings: SettingsOut;
  online: boolean;
  onSave(patch: SettingsPatch): Promise<boolean>;
}

const FIELDS: readonly { key: TargetKey; label: string }[] = [
  { key: 'focus_daily_target_min', label: 'هدف دقائق التركيز اليومي' },
  { key: 'breath_weekly_target_min', label: 'هدف دقائق التنفّس الأسبوعي' },
];

const textOf = (value: number | null | undefined): string => (value === null || value === undefined ? '' : String(value));

/** «الأهداف الرقمية»: the daily focus minutes and the weekly breathing minutes. Both are empty until
 *  the person sets them (design ruling 19): no number is made up. An empty field is saved as `null`. */
export function TargetsSection({ settings, online, onSave }: TargetsSectionProps) {
  const [texts, setTexts] = useState<Record<TargetKey, string>>({
    focus_daily_target_min: textOf(settings.focus_daily_target_min),
    breath_weekly_target_min: textOf(settings.breath_weekly_target_min),
  });
  const saving = useSaving();

  // What changed since the last save, and whether every changed field is a good number.
  const patch: SettingsPatch = {};
  const refused = new Set<TargetKey>();
  for (const { key } of FIELDS) {
    const parsed = parseTarget(texts[key]);
    if (parsed === undefined) {
      refused.add(key);
    } else if (parsed !== (settings[key] ?? null)) {
      patch[key] = parsed;
    }
  }
  const changed = Object.keys(patch).length > 0;

  return (
    <Card title="الأهداف الرقمية" class="settings-card">
      <p class="settings-note">يبقى الحقل الفارغ بلا هدف، ولا يُقترح رقم.</p>
      {FIELDS.map(({ key, label }) => (
        <Field
          key={key}
          label={label}
          // A text field, not a number field: a browser gives a number field an empty value for «1e»,
          // which would read as «no target» and delete the saved one. The raw text is what is checked.
          type="text"
          inputMode="numeric"
          value={texts[key]}
          hint={`من ${MIN_TARGET} إلى ${MAX_TARGET} دقيقة`}
          error={refused.has(key) ? TARGET_ERROR : undefined}
          disabled={!online}
          onInput={(value) => {
            saving.reset();
            setTexts((t) => ({ ...t, [key]: value }));
          }}
        />
      ))}
      <div class="settings-actions">
        <Button
          variant="primary"
          disabled={!online || saving.busy || !changed || refused.size > 0}
          onClick={() => void saving.run(() => onSave(patch))}
        >
          حفظ الأهداف
        </Button>
        {!online && <span class="settings-hint">{OFFLINE_NOTE}</span>}
      </div>
      <SaveNote status={saving.status} />
    </Card>
  );
}
