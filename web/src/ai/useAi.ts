// How a screen calls the AI (design section 10): one call, five answers, and the consent asked for
// at the moment it is missing. The browser sends the question and the range, nothing else: the
// server builds the sources.

import { type ComponentChildren, h } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

import { Unauthorized } from '../api/auth';
import { api } from '../api/client';
import { HttpError } from '../api/unwrap';
import { OFFLINE_NOTE } from '../lib/notes';
import { isAbortOrTimeout } from '../lib/timeout';
import { ConsentDialog } from './ConsentDialog';
import { UNAVAILABLE_TEXT } from './guard';
import type { Provider } from './providers';

export { PROVIDER_LABELS, type Provider } from './providers';

export type AiResult<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'consent_required' }
  | { kind: 'offline' }
  | { kind: 'unavailable'; message: string }
  | { kind: 'refused'; message: string };

/** The code the server gives a call that needs a consent (`errors[0].type`). */
export const CONSENT_REQUIRED = 'ai_consent_required';

/** A refused AI call: the status, the words of the server (`detail`) and its code. */
export class AiHttpError extends HttpError {
  readonly detail: string | undefined;
  readonly code: string | undefined;

  constructor(status: number, detail?: string, code?: string) {
    super(status);
    this.name = 'AiHttpError';
    this.detail = detail;
    this.code = code;
  }
}

interface Reply<T> {
  data?: T;
  error?: unknown;
  response: Response;
}

/** The data of an openapi-fetch result, or a thrown `AiHttpError` that keeps what the server said. */
export function unwrapAi<T>(result: Reply<T>): T {
  if (result.response.ok && result.data !== undefined) return result.data;
  const body = result.error as { detail?: unknown; errors?: { type?: unknown }[] } | undefined;
  const detail = typeof body?.detail === 'string' && body.detail !== '' ? body.detail : undefined;
  const code = typeof body?.errors?.[0]?.type === 'string' ? body.errors[0].type : undefined;
  throw new AiHttpError(result.response.status, detail, code);
}

const online = (): boolean => typeof navigator === 'undefined' || navigator.onLine !== false;

/** Runs `call` and sorts what comes back: the value, a missing consent (403 `ai_consent_required`),
 *  no connection, a refusal of the request (422), or an unavailable service (anything else), each
 *  with the words of the server when it gave some. Nothing is sent while the browser is offline. */
export async function callAi<T>(call: () => Promise<T>): Promise<AiResult<T>> {
  if (!online()) return { kind: 'offline' };
  try {
    return { kind: 'ok', value: await call() };
  } catch (error: unknown) {
    if (error instanceof TypeError || isAbortOrTimeout(error)) return { kind: 'offline' };
    if (error instanceof AiHttpError) {
      const message = error.detail ?? UNAVAILABLE_TEXT;
      if (error.status === 403 && error.code === CONSENT_REQUIRED) return { kind: 'consent_required' };
      if (error.status === 422) return { kind: 'refused', message };
      return { kind: 'unavailable', message };
    }
    if (error instanceof Unauthorized || error instanceof HttpError) return { kind: 'unavailable', message: UNAVAILABLE_TEXT };
    throw error;
  }
}

export interface RunOptions {
  /** Open the consent dialog when the consent is missing (default). With `false` the missing
   *  consent is only returned, and the screen shows its «تفعيل الذكاء الاصطناعي» button. */
  prompt?: boolean;
}

export interface UseAi {
  /** `callAi`, and when the consent is missing the dialog: «موافقة» puts the consent and repeats
   *  `call` once; «ليس الآن» ends with `consent_required`. Resolves when that is settled. */
  run<T>(call: () => Promise<T>, options?: RunOptions): Promise<AiResult<T>>;
  /** Render this once on the screen: it is the consent dialog (nothing while it is closed). */
  dialog: ComponentChildren;
}

interface Waiting {
  call: () => Promise<unknown>;
  settle(result: AiResult<unknown>): void;
}

const GRANT_FAILED = 'تعذّر حفظ الموافقة؛ يمكن المحاولة ثانية';
const MISMATCH = 'المزوّد تغيّر؛ الاسم المعروض هو المزوّد الحالي';

export function useAi(): UseAi {
  const [open, setOpen] = useState(false);
  const [provider, setProvider] = useState<Provider | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const waiting = useRef<Waiting | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const loadProvider = useCallback(async (): Promise<void> => {
    try {
      const read = await api.GET('/v1/ai/consent');
      if (!alive.current) return;
      if (read.data !== undefined) setProvider(read.data.provider);
      else setError(GRANT_FAILED);
    } catch {
      if (alive.current) setError(online() ? GRANT_FAILED : OFFLINE_NOTE);
    }
  }, []);

  const run = useCallback(
    async <T>(call: () => Promise<T>, options: RunOptions = {}): Promise<AiResult<T>> => {
      const first = await callAi(call);
      if (first.kind !== 'consent_required' || options.prompt === false) return first;
      // One question at a time: an older one that still waits ends without a consent.
      waiting.current?.settle({ kind: 'consent_required' });
      return new Promise<AiResult<T>>((resolve) => {
        waiting.current = { call, settle: (result) => resolve(result as AiResult<T>) };
        setProvider(null);
        setError(null);
        setBusy(false);
        setOpen(true);
        void loadProvider();
      });
    },
    [loadProvider],
  );

  const later = (): void => {
    const current = waiting.current;
    waiting.current = null;
    setOpen(false);
    current?.settle({ kind: 'consent_required' });
  };

  const grant = async (personalText: boolean): Promise<void> => {
    const current = waiting.current;
    if (!current || provider === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      const put = await api.PUT('/v1/ai/consent', { body: { provider, personal_text: personalText } });
      if (put.response.status === 409) {
        setBusy(false);
        setError(MISMATCH);
        void loadProvider();
        return;
      }
      if (!put.response.ok) {
        setBusy(false);
        setError(GRANT_FAILED);
        return;
      }
    } catch {
      if (alive.current) {
        setBusy(false);
        setError(online() ? GRANT_FAILED : OFFLINE_NOTE);
      }
      return;
    }
    // The consent stands: close the dialog and repeat the original call, once.
    waiting.current = null;
    if (alive.current) {
      setBusy(false);
      setOpen(false);
    }
    current.settle(await callAi(current.call));
  };

  const dialog = h(ConsentDialog, { open, provider, busy, error, onConsent: (p: boolean) => void grant(p), onLater: later });
  return { run, dialog };
}
