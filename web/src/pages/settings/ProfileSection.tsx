import { useState } from 'preact/hooks';

import type { SettingsOut, SettingsPatch } from '../../settings/data';
import { OFFLINE_NOTE, SaveNote, useSaving } from '../../settings/saving';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { Field } from '../../ui/Field';

/** The longest «رسالتي» or «رؤيتي» (design 7.3). */
export const MAX_PROFILE = 600;

export interface ProfileSectionProps {
  settings: SettingsOut;
  online: boolean;
  onSave(patch: SettingsPatch): Promise<boolean>;
}

/** «رسالتي ورؤيتي»: the person's own words, saved as written. Nothing here is written for them, and
 *  nothing is suggested. */
export function ProfileSection({ settings, online, onSave }: ProfileSectionProps) {
  const [mission, setMission] = useState(settings.mission);
  const [vision, setVision] = useState(settings.vision);
  const saving = useSaving();
  // What changed since the last save: only that is sent.
  const patch: SettingsPatch = {};
  if (mission !== settings.mission) patch.mission = mission;
  if (vision !== settings.vision) patch.vision = vision;
  const changed = Object.keys(patch).length > 0;

  return (
    <Card title="رسالتي ورؤيتي" class="settings-card">
      <p class="settings-note">يُحفظ النص كما كُتب، ويظهر في الرئيسية بلا أي تعديل.</p>
      <Field
        label="رسالتي"
        multiline
        value={mission}
        maxLength={MAX_PROFILE}
        onInput={(value) => {
          saving.reset();
          setMission(value);
        }}
      />
      <Field
        label="رؤيتي"
        multiline
        value={vision}
        maxLength={MAX_PROFILE}
        onInput={(value) => {
          saving.reset();
          setVision(value);
        }}
      />
      <div class="settings-actions">
        <Button variant="primary" disabled={!online || saving.busy || !changed} onClick={() => void saving.run(() => onSave(patch))}>
          حفظ رسالتي ورؤيتي
        </Button>
        {!online && <span class="settings-hint">{OFFLINE_NOTE}</span>}
      </div>
      <SaveNote status={saving.status} />
    </Card>
  );
}
