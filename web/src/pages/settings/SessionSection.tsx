import { logout } from '../../data/session';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';

export interface SessionSectionProps {
  deviceName?: string;
  disabled?: boolean;
  onLogout?(): void;
}

export function SessionSection({ deviceName = 'متصفح الحاسوب', disabled, onLogout }: SessionSectionProps) {
  const handleLogout = () => {
    if (onLogout) {
      onLogout();
    } else {
      void logout();
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
            <p style={{ margin: 0, fontWeight: 500 }}>{deviceName}</p>
          </div>
          <Button variant="quiet" onClick={handleLogout} disabled={disabled}>
            خروج
          </Button>
        </div>
      </Card>
    </section>
  );
}
