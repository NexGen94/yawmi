import { useState } from 'preact/hooks';

import { logout } from '../../data/session';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';

export interface SessionSectionProps {
  deviceName?: string;
  disabled?: boolean;
  /** This device has a session. Without one there is nothing to sign out of. */
  paired?: boolean;
  onLogout?(): void | Promise<void>;
}

export function SessionSection({ deviceName, disabled, paired = true, onLogout }: SessionSectionProps) {
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);

  const handleLogout = async () => {
    if (disabled || !paired || loggingOut) return;
    setLogoutError(null);
    setLoggingOut(true);
    try {
      if (onLogout) {
        await onLogout();
      } else {
        await logout();
      }
    } catch {
      setLogoutError('تعذّر تسجيل الخروج');
    } finally {
      setLoggingOut(false);
    }
  };

  return (
    <Card title="هذا الجهاز" class="settings-card">
      <div class="settings-device">
        <p class="settings-device-name">{deviceName || '—'}</p>
        <div class="settings-actions">
          <Button
            variant="quiet"
            onClick={() => void handleLogout()}
            disabled={disabled || !paired || loggingOut}
            title={disabled ? 'يحتاج اتصالاً' : undefined}
          >
            خروج
          </Button>
          {disabled && <span class="settings-hint">يحتاج اتصالاً</span>}
          {!paired && !disabled && <span class="settings-hint">هذا الجهاز غير مقترن</span>}
        </div>
      </div>

      {logoutError && (
        <div class="settings-alert" role="alert">
          <p class="settings-error">{logoutError}</p>
          <Button variant="quiet" onClick={() => void handleLogout()} disabled={disabled}>
            إعادة المحاولة
          </Button>
        </div>
      )}
    </Card>
  );
}
