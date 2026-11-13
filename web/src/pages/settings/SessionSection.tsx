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
    <section class="settings-section" aria-labelledby="session-heading">
      <Card>
        <h2 id="session-heading" style={{ fontSize: 'var(--fs-title)', marginBottom: '0.75rem' }}>
          هذا الجهاز
        </h2>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem' }}>
          <div>
            <p style={{ margin: 0, fontWeight: 500 }}>{deviceName || '—'}</p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
            <Button
              variant="quiet"
              onClick={() => void handleLogout()}
              disabled={disabled || !paired || loggingOut}
              title={disabled ? 'يحتاج اتصالاً' : undefined}
            >
              خروج
            </Button>
            {disabled && (
              <span style={{ fontSize: 'var(--fs-note)', color: 'var(--c-muted)' }}>
                يحتاج اتصالاً
              </span>
            )}
            {!paired && !disabled && (
              <span style={{ fontSize: 'var(--fs-note)', color: 'var(--c-muted)' }}>هذا الجهاز غير مقترن</span>
            )}
          </div>
        </div>

        {logoutError && (
          <div role="alert" style={{ marginTop: '0.75rem' }}>
            <p style={{ color: 'var(--c-signal)', margin: '0 0 0.5rem 0', fontSize: 'var(--fs-note)' }}>
              {logoutError}
            </p>
            <Button variant="quiet" onClick={() => void handleLogout()} disabled={disabled}>
              إعادة المحاولة
            </Button>
          </div>
        )}
      </Card>
    </section>
  );
}
