import { useEffect, useState } from 'preact/hooks';

import { kvGet } from '../../data/cache';
import type { QueryState } from '../../data/query';
import { useDigits } from '../../settings/digits';
import { useSettings } from '../../settings/data';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { Skeleton } from '../../ui/Skeleton';
import { StateFrame } from '../../ui/StateFrame';
import { DayRemindersSection } from './DayRemindersSection';
import { DisplaySection } from './DisplaySection';
import { NotificationsSection } from './NotificationsSection';
import { ProfileSection } from './ProfileSection';
import { SessionSection } from './SessionSection';
import { ShortcutsSection } from './ShortcutsSection';
import './settings.css';

export interface SettingsPageProps {
  state?: QueryState;
  stale?: boolean;
  deviceName?: string;
  onRetry?(): void;
}

export default function SettingsPage(props: SettingsPageProps) {
  // The numbers on this page are drawn again when the digits setting changes.
  useDigits();
  const settings = useSettings();
  const [loading, setLoading] = useState<boolean>(props.state === undefined);
  const [error, setError] = useState<boolean>(false);
  const [deviceInfo, setDeviceInfo] = useState<{ id?: string; name?: string } | null>(null);
  const [isOnline, setIsOnline] = useState<boolean>(() =>
    typeof navigator !== 'undefined' ? navigator.onLine : true,
  );
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  useEffect(() => {
    if (props.state !== undefined) return;
    let cancelled = false;
    setLoading(true);
    setError(false);

    Promise.all([kvGet<string>('device_id'), kvGet<string>('device_name')])
      .then(([id, name]) => {
        if (cancelled) return;
        if (id) {
          setDeviceInfo({ id, name: name ?? 'متصفح الحاسوب' });
        } else {
          setDeviceInfo(null);
        }
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setError(true);
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [props.state, nonce]);

  let computedState: QueryState;
  if (props.state !== undefined) {
    computedState = props.state;
  } else if (error) {
    computedState = 'error';
  } else if (!isOnline) {
    computedState = 'offline';
  } else if (loading) {
    computedState = 'loading';
  } else {
    computedState = 'ready';
  }

  const isOffline = computedState === 'offline';
  const stale = props.stale ?? (isOffline && !loading && !error);
  const deviceName = props.deviceName ?? deviceInfo?.name;

  const handleRetry = () => {
    if (props.onRetry) {
      props.onRetry();
    } else {
      setNonce((n) => n + 1);
    }
  };

  const skeleton = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <Skeleton blockSize="100px" inlineSize="100%" />
      <Skeleton blockSize="140px" inlineSize="100%" />
    </div>
  );

  return (
    <div class="settings-page">
      <h1>الإعدادات</h1>

      <StateFrame
        state={computedState}
        stale={stale}
        emptyText=""
        empty={false}
        onRetry={handleRetry}
        skeleton={skeleton}
      >
        {settings.data !== undefined ? (
          <ProfileSection key="profile" settings={settings.data} online={!isOffline} onSave={settings.save} />
        ) : (
          <SettingsUnread loading={settings.query.state === 'loading'} onRetry={settings.query.reload} />
        )}
        <NotificationsSection disabled={isOffline} />
        {settings.data !== undefined && (
          <>
            <DayRemindersSection settings={settings.data} online={!isOffline} onSave={settings.save} />
            <DisplaySection settings={settings.data} online={!isOffline} onSave={settings.save} />
          </>
        )}
        <SessionSection deviceName={deviceName} disabled={isOffline} />
        <ShortcutsSection />
      </StateFrame>
    </div>
  );
}

/** The settings of the person could not be read (or are being read): the sections that need them wait. */
function SettingsUnread({ loading, onRetry }: { loading: boolean; onRetry(): void }) {
  if (loading) return <Skeleton blockSize="140px" inlineSize="100%" />;
  return (
    <Card title="رسالتي ورؤيتي والتذكيرات والعرض" class="settings-card">
      <p class="settings-note">تعذّرت قراءة هذه الإعدادات الآن.</p>
      <Button onClick={onRetry}>إعادة قراءة الإعدادات</Button>
    </Card>
  );
}
