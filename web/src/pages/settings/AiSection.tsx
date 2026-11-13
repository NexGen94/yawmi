import { useState } from 'preact/hooks';

import { ConsentDialog, ConsentNotice } from '../../ai/ConsentDialog';
import { PROVIDER_LABELS } from '../../ai/providers';
import { OFFLINE_NOTE, SaveNote, useSaving } from '../../settings/saving';
import type { UseConsent } from '../../settings/aiData';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { Skeleton } from '../../ui/Skeleton';

export interface AiSectionProps {
  consent: UseConsent;
  online: boolean;
}

/** «الذكاء الاصطناعي»: the provider that is current, whether the consent stands, the key for
 *  «رسالتي» و«رؤيتي», and the way to give or withdraw the consent. A change needs the connection. */
export function AiSection({ consent, online }: AiSectionProps) {
  const saving = useSaving();
  const [asking, setAsking] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const data = consent.data;

  const run = (work: () => Promise<string | null>): Promise<boolean> =>
    saving.run(async () => {
      const message = await work();
      setError(message);
      return message === null;
    });

  let body;
  if (data === undefined) {
    body =
      consent.state === 'error' ? (
        <div class="state-message">
          <p class="state-text">تعذّرت قراءة الموافقة</p>
          <Button onClick={consent.reload}>إعادة المحاولة</Button>
        </div>
      ) : consent.state === 'offline' ? (
        <p class="settings-note">{OFFLINE_NOTE}</p>
      ) : (
        <Skeleton blockSize="80px" inlineSize="100%" />
      );
  } else {
    const label = PROVIDER_LABELS[data.provider];
    body = (
      <>
        <p class="settings-note">
          المزوّد الحالي: <bdi dir="ltr">{label}</bdi>
        </p>
        {data.granted ? (
          <>
            <p class="settings-note">الموافقة قائمة: أرقام العادات والأهداف وكلمات اليومية تُرسل إلى المزوّد عند كل طلب.</p>
            <label class="settings-switch">
              <input
                type="checkbox"
                checked={data.personal_text}
                disabled={!online || saving.busy}
                onChange={(event) => void run(() => consent.grant(event.currentTarget.checked))}
              />
              <span>إرسال «رسالتي» و«رؤيتي» أيضاً</span>
            </label>
            <div class="settings-actions">
              <Button disabled={!online || saving.busy} onClick={() => void run(consent.withdraw)}>
                سحب الموافقة
              </Button>
            </div>
          </>
        ) : (
          <ConsentNotice disabled={!online} onEnable={() => setAsking(true)} />
        )}
        <ConsentDialog
          open={asking}
          provider={data.provider}
          busy={saving.busy}
          error={dialogError}
          onConsent={(personalText) => {
            setDialogError(null);
            void saving.run(async () => {
              const message = await consent.grant(personalText);
              setDialogError(message);
              if (message === null) setAsking(false);
              return message === null;
            });
          }}
          onLater={() => {
            setAsking(false);
            setDialogError(null);
          }}
        />
      </>
    );
  }

  return (
    <Card title="الذكاء الاصطناعي" class="settings-card">
      {body}
      {!online && <p class="settings-hint">{OFFLINE_NOTE}</p>}
      {error !== null && (
        <p class="settings-error" role="alert">
          {error}
        </p>
      )}
      {error === null && <SaveNote status={saving.status} />}
    </Card>
  );
}
