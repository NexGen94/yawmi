import { useEffect, useState } from 'preact/hooks';

import { kvGet } from '../../data/cache';
import type { QueryState } from '../../data/query';
import { Skeleton } from '../../ui/Skeleton';
import { StateFrame } from '../../ui/StateFrame';
import { NotificationsSection } from './NotificationsSection';
import { SessionSection } from './SessionSection';

export interface SettingsPageProps {
  state?: QueryState;
  stale?: boolean;
  deviceName?: string;
  onRetry?(): void;
}

export default function SettingsPage(props: SettingsPageProps) {
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
        <SessionSection deviceName={deviceName} disabled={isOffline} />
        <NotificationsSection disabled={isOffline} />
      </StateFrame>
    </div>
  );
}
