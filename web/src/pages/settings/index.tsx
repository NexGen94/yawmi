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
  const [storedName, setStoredName] = useState<string>('متصفح الحاسوب');
  const [internalState, setInternalState] = useState<QueryState>('ready');

  useEffect(() => {
    void kvGet<string>('device_name').then((name) => {
      if (name) setStoredName(name);
    });
  }, []);

  const state = props.state ?? internalState;
  const stale = props.stale ?? false;
  const deviceName = props.deviceName ?? storedName;
  const isOffline = state === 'offline';

  const handleRetry = () => {
    if (props.onRetry) {
      props.onRetry();
    } else {
      setInternalState('ready');
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
        state={state}
        stale={stale}
        emptyText=""
        empty={false}
        onRetry={handleRetry}
        skeleton={skeleton}
      >
        <SessionSection deviceName={deviceName} />
        <NotificationsSection disabled={isOffline} />
      </StateFrame>
    </div>
  );
}
