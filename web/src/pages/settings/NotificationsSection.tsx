import { useState } from 'preact/hooks';

import { enablePush, PUSH_UNSUPPORTED_MESSAGE } from '../../push/subscribe';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';

export interface NotificationsSectionProps {
  disabled?: boolean;
}

export function NotificationsSection({ disabled }: NotificationsSectionProps) {
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [subscribing, setSubscribing] = useState(false);

  const handleEnablePush = async () => {
    if (subscribing || disabled) return;
    setSubscribing(true);
    setStatusMessage(null);

    try {
      const outcome = await enablePush();
      if (outcome === 'unsupported') {
        setStatusMessage(PUSH_UNSUPPORTED_MESSAGE);
      } else if (outcome === 'granted') {
        setStatusMessage('تم تفعيل التذكيرات');
      } else if (outcome === 'denied') {
        setStatusMessage('تم رفض إذن الإشعارات من المتصفح');
      }
    } catch {
      setStatusMessage('تعذّر تفعيل التذكيرات');
    } finally {
      setSubscribing(false);
    }
  };

  return (
    <section class="settings-section" aria-labelledby="notifications-heading" style={{ marginTop: '1.5rem' }}>
      <Card>
        <h2 id="notifications-heading" style={{ fontSize: 'var(--fs-title)', marginBottom: '0.75rem' }}>
          الإشعارات والتذكيرات
        </h2>
        <p style={{ color: 'var(--c-muted)', fontSize: 'var(--fs-body)', marginBottom: '1rem' }}>
          تنبيهات يومية لتسجيل العادات والمتأخرات في أوقاتها المحددة.
        </p>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
          <Button
            variant="quiet"
            onClick={() => void handleEnablePush()}
            disabled={disabled || subscribing}
            title={disabled ? 'يحتاج اتصالاً' : undefined}
          >
            تفعيل الإشعارات
          </Button>
          {disabled && (
            <span style={{ fontSize: 'var(--fs-note)', color: 'var(--c-muted)' }}>
              يحتاج اتصالاً
            </span>
          )}
        </div>

        {statusMessage && (
          <p
            role="status"
            style={{
              marginTop: '0.75rem',
              fontSize: 'var(--fs-note)',
              color: statusMessage === PUSH_UNSUPPORTED_MESSAGE ? 'var(--c-signal)' : 'inherit',
            }}
          >
            {statusMessage}
          </p>
        )}
      </Card>
    </section>
  );
}
