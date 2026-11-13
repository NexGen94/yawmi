import { fmt } from '../../lib/format';
import type { SettingsOut, SettingsPatch } from '../../settings/data';
import { OFFLINE_NOTE, SaveNote, useSaving } from '../../settings/saving';
import { Card } from '../../ui/Card';
import { type Option, Segmented } from '../../ui/Segmented';

const OPTIONS: readonly Option<SettingsOut['digits']>[] = [
  { value: 'latn', label: 'أرقام غربية' },
  { value: 'arab', label: 'أرقام هندية' },
];

export interface DisplaySectionProps {
  settings: SettingsOut;
  online: boolean;
  onSave(patch: SettingsPatch): Promise<boolean>;
}

/** «العرض»: the shape of the numbers. The choice is applied to the whole app as soon as the server
 *  has it, and a sample shows what it looks like. */
export function DisplaySection({ settings, online, onSave }: DisplaySectionProps) {
  const saving = useSaving();
  return (
    <Card title="العرض" class="settings-card">
      <Segmented
        label="شكل الأرقام"
        options={OPTIONS}
        value={settings.digits}
        disabled={!online || saving.busy}
        onChange={(digits) => void saving.run(() => onSave({ digits }))}
      />
      <p class="settings-note">
        {'مثال: '}
        <span data-testid="digits-sample" class="settings-sample">
          {fmt.num(12)}
        </span>
      </p>
      {!online && <p class="settings-hint">{OFFLINE_NOTE}</p>}
      <SaveNote status={saving.status} />
    </Card>
  );
}
