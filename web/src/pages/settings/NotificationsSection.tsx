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
    <Card title="الإشعارات والتذكيرات" class="settings-card">
      <p class="settings-note">تنبيهات يومية لتسجيل العادات والمتأخرات في أوقاتها المحددة.</p>

      <div class="settings-actions">
        <Button
          variant="quiet"
          onClick={() => void handleEnablePush()}
          disabled={disabled || subscribing}
          title={disabled ? 'يحتاج اتصالاً' : undefined}
        >
          تفعيل الإشعارات
        </Button>
        {disabled && <span class="settings-hint">يحتاج اتصالاً</span>}
      </div>

      {statusMessage && (
        <p role="status" class={statusMessage === PUSH_UNSUPPORTED_MESSAGE ? 'settings-error' : 'settings-status'}>
          {statusMessage}
        </p>
      )}
    </Card>
  );
}
