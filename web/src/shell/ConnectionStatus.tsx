import { useEffect, useState } from 'preact/hooks';

// The connection state at the foot of the sidebar (in the top bar under 900px). A polite live
// region, so a screen reader hears the change without losing its place.
export function ConnectionStatus() {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));

  useEffect(() => {
    const up = (): void => setOnline(true);
    const down = (): void => setOnline(false);
    addEventListener('online', up);
    addEventListener('offline', down);
    return () => {
      removeEventListener('online', up);
      removeEventListener('offline', down);
    };
  }, []);

  return (
    <p class="connection" role="status" aria-live="polite" data-state={online ? 'online' : 'offline'}>
      <span class="connection-dot" aria-hidden="true" />
      <span class="connection-label">{online ? 'متصل' : 'بلا اتصال'}</span>
      {online ? null : <span class="connection-note">تُحفظ التسجيلات على الجهاز وتُرسل عند عودة الاتصال.</span>}
    </p>
  );
}
