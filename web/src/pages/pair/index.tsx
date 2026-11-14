import { useEffect, useState } from 'preact/hooks';

import { pairDevice } from '../../data/session';
import { navigate } from '../../lib/navigate';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { Field } from '../../ui/Field';
import './pair.css';

export default function PairPage() {
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isNetworkError, setIsNetworkError] = useState(false);
  const [isOffline, setIsOffline] = useState(
    typeof navigator !== 'undefined' && navigator.onLine === false,
  );

  useEffect(() => {
    const handleOnline = () => setIsOffline(false);
    const handleOffline = () => setIsOffline(true);

    if (typeof window !== 'undefined') {
      window.addEventListener('online', handleOnline);
      window.addEventListener('offline', handleOffline);
      return () => {
        window.removeEventListener('online', handleOnline);
        window.removeEventListener('offline', handleOffline);
      };
    }
  }, []);

  const submit = async () => {
    if (!code.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    setIsNetworkError(false);

    try {
      await pairDevice(code.trim());
      navigate('/');
    } catch (err: unknown) {
      setSubmitting(false);
      const isNet =
        err instanceof TypeError ||
        (err as { name?: string })?.name === 'TypeError' ||
        (err as { message?: string })?.message?.includes('Failed to fetch') ||
        (err as { cause?: unknown })?.cause instanceof TypeError;

      if (isNet) {
        setIsNetworkError(true);
        setError('تعذّر الاتصال');
      } else {
        const message = (err as Error)?.message || 'تعذّر الإقران';
        setError(message);
      }
    }
  };

  return (
    <div class="pair-page">
      <h1>الإقران</h1>

      <Card>
        {isOffline && (
          <div class="pair-notice" role="alert">
            يحتاج اتصالاً
          </div>
        )}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Field
            label="كود الإقران"
            value={code}
            onInput={(val) => {
              setCode(val);
              setError(null);
              setIsNetworkError(false);
            }}
            placeholder="مثال: ABCD2345"
            error={!isNetworkError && error ? error : undefined}
            disabled={submitting}
            autoComplete="off"
          />

          {isNetworkError && (
            <div class="pair-error" role="alert">
              <p class="pair-error-text">تعذّر الاتصال</p>
              <Button variant="quiet" onClick={() => void submit()} disabled={isOffline}>
                إعادة المحاولة
              </Button>
            </div>
          )}

          <div class="pair-submit">
            <Button
              type="submit"
              variant="primary"
              disabled={submitting || !code.trim() || isOffline}
            >
              إقران هذا الجهاز
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
