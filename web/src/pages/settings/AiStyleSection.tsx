import type { SettingsOut, SettingsPatch } from '../../settings/data';
import { OFFLINE_NOTE, SaveNote, useSaving } from '../../settings/saving';
import { Card } from '../../ui/Card';
import { type Option, Segmented } from '../../ui/Segmented';

// Labels are nouns. The three values go to the server as they are: `ai_lines` and `ai_tone` enter
// the context of every request (the style of the reply), and `ai_checkin` says where the summary
// card of the day shows (design 4.1).
const LINES: readonly Option<'1' | '2'>[] = [
  { value: '1', label: 'سطر واحد' },
  { value: '2', label: 'سطران' },
];
const TONES: readonly Option<SettingsOut['ai_tone'] & string>[] = [
  { value: 'direct', label: 'مباشر' },
  { value: 'explained', label: 'مع الشرح' },
];
const CHECKINS: readonly Option<SettingsOut['ai_checkin'] & string>[] = [
  { value: 'morning', label: 'في الصباح' },
  { value: 'evening', label: 'بعد إغلاق اليوم' },
];

export interface AiStyleSectionProps {
  settings: SettingsOut;
  online: boolean;
  onSave(patch: SettingsPatch): Promise<boolean>;
}

/** «أسلوب الرد»: how many lines, how direct, and where the summary of the day shows. Each choice is
 *  saved as soon as it is made. */
export function AiStyleSection({ settings, online, onSave }: AiStyleSectionProps) {
  const saving = useSaving();
  const off = !online || saving.busy;
  return (
    <Card title="أسلوب الرد" class="settings-card">
      <Segmented
        label="عدد السطور"
        options={LINES}
        value={String(settings.ai_lines ?? 2) as '1' | '2'}
        disabled={off}
        onChange={(value) => void saving.run(() => onSave({ ai_lines: Number(value) as 1 | 2 }))}
      />
      <Segmented
        label="نبرة الرد"
        options={TONES}
        value={settings.ai_tone ?? 'direct'}
        disabled={off}
        onChange={(ai_tone) => void saving.run(() => onSave({ ai_tone }))}
      />
      <Segmented
        label="موضع ملخص اليوم"
        options={CHECKINS}
        value={settings.ai_checkin ?? 'evening'}
        disabled={off}
        onChange={(ai_checkin) => void saving.run(() => onSave({ ai_checkin }))}
      />
      <p class="settings-note">الرد تقدير من أرقام الأيام وكلماتها، وليس علاجاً ولا تشخيصاً ولا نصيحة مالية.</p>
      {!online && <p class="settings-hint">{OFFLINE_NOTE}</p>}
      <SaveNote status={saving.status} />
    </Card>
  );
}
