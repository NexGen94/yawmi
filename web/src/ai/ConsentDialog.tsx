/// <reference types="vite/client" />
// (for the stylesheet import below: the test tsconfig does not load vite client types itself)

import { useEffect, useState } from 'preact/hooks';

import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import './ai.css';
import { PROVIDER_LABELS, type Provider } from './providers';

/** What goes to the provider once the consent is given (design 10): the numbers of the habits and
 *  of the goals, the words of the journal, and what the memory holds. */
export const SENT_ITEMS: readonly string[] = [
  'أرقام العادات وتقدّمها',
  'أرقام الأهداف والمحطات',
  'كلمات اليومية والمزاج',
  'العدسات والملاحظات المفعّلة في الذاكرة',
];

export interface ConsentDialogProps {
  open: boolean;
  /** The current provider, once the server has said it (null until then). */
  provider: Provider | null;
  busy?: boolean;
  /** Why the last try did not work, in words. */
  error?: string | null;
  /** «موافقة», with the state of the key for رسالتي ورؤيتي. */
  onConsent(personalText: boolean): void;
  /** «ليس الآن», the close button and Escape. */
  onLater(): void;
}

/** The consent to send data to the AI provider: names it, counts what is sent, and keeps the key for
 *  «رسالتي» and «رؤيتي» off until it is turned on here. */
export function ConsentDialog({ open, provider, busy = false, error = null, onConsent, onLater }: ConsentDialogProps) {
  const [personal, setPersonal] = useState(false);
  // A new asking starts from the key closed.
  useEffect(() => {
    if (open) setPersonal(false);
  }, [open]);
  const label = provider === null ? null : PROVIDER_LABELS[provider];
  return (
    <Dialog
      open={open}
      title={label === null ? 'الموافقة على إرسال البيانات' : `الموافقة على إرسال البيانات إلى ${label}`}
      onClose={onLater}
      actions={
        <>
          <Button variant="primary" disabled={provider === null || busy} onClick={() => onConsent(personal)}>
            موافقة
          </Button>
          <Button disabled={busy} onClick={onLater}>
            ليس الآن
          </Button>
        </>
      }
    >
      <div class="ai-consent">
        <p class="ai-consent-lead">
          {label === null ? (
            'جارٍ تحديد المزوّد الحالي'
          ) : (
            <>
              الذكاء الاصطناعي يعمل عبر مزوّد خارجي: <bdi dir="ltr">{label}</bdi>. بعد الموافقة يُرسل إليه:
            </>
          )}
        </p>
        <ul class="ai-consent-list" aria-label="ما يُرسل">
          {SENT_ITEMS.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <label class="ai-switch">
          <input type="checkbox" checked={personal} disabled={busy} onChange={(event) => setPersonal(event.currentTarget.checked)} />
          <span>إرسال «رسالتي» و«رؤيتي» أيضاً</span>
        </label>
        <p class="ai-note">مغلق افتراضاً. يُرسل نص «رسالتي» و«رؤيتي» إن وُجد، ولا يكتب الذكاء الاصطناعي بدلاً عنهما.</p>
        <p class="ai-note">الموافقة قابلة للسحب من الإعدادات في أي وقت.</p>
        {error && (
          <p class="ai-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

/** What a card says while there is no consent, with the way to give it. */
export function ConsentNotice({ onEnable, disabled }: { onEnable(): void; disabled?: boolean }) {
  return (
    <div class="state-message ai-paused">
      <p class="state-text">الذكاء الاصطناعي متوقف حتى الموافقة</p>
      <Button disabled={disabled} onClick={onEnable}>
        تفعيل الذكاء الاصطناعي
      </Button>
    </div>
  );
}
