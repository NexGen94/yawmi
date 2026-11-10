// Web Push subscription for habit reminders. No screen calls this yet (no UI until the design is
// approved, D-061): a future button calls `enablePush()` from inside its click handler.
//
// iOS allows Web Push only for a web app added to the Home Screen and opened from its icon, and
// only from a user gesture. So the standalone check comes first, and
// `Notification.requestPermission()` is the first thing awaited, while the click still counts as
// a user activation; the server key is fetched only after that.

import { authedFetch } from '../api/auth';

export type PushOutcome = 'granted' | 'denied' | 'unsupported';

/** Shown by the caller when `enablePush()` returns `unsupported`. Neutral wording, no imperative. */
export const PUSH_UNSUPPORTED_MESSAGE = 'تُفعَّل التذكيرات بعد إضافة يومي إلى الشاشة الرئيسية';

const KEY_URL = '/v1/push/vapid-public-key';
const SUBSCRIBE_URL = '/v1/push/subscribe';

/** The server refused the key or the subscription. `message` is Arabic and safe to show. */
export class PushSetupError extends Error {
  readonly status: number | undefined;

  constructor(status?: number) {
    super('تعذّر تفعيل التذكيرات');
    this.name = 'PushSetupError';
    this.status = status;
  }
}

function isStandalone(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches;
}

function pushSupported(): boolean {
  return (
    typeof Notification !== 'undefined' &&
    typeof Notification.requestPermission === 'function' &&
    typeof PushManager !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    navigator.serviceWorker !== undefined
  );
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=');
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function sameKey(current: ArrayBuffer | null | undefined, wanted: Uint8Array): boolean {
  if (!current) return false;
  const a = new Uint8Array(current);
  return a.length === wanted.length && a.every((byte, i) => byte === wanted[i]);
}

async function serverKey(): Promise<Uint8Array<ArrayBuffer>> {
  const res = await authedFetch(KEY_URL);
  if (!res.ok) throw new PushSetupError(res.status);
  const body: unknown = await res.json().catch(() => null);
  const key = (body as { key?: unknown } | null)?.key;
  if (typeof key !== 'string' || key === '') throw new PushSetupError();
  return fromBase64Url(key);
}

/**
 * Ask for notification permission and register this device's push subscription with the server.
 * Call it only from inside a click. `unsupported`: not opened from the Home Screen icon, or no
 * Push API (show `PUSH_UNSUPPORTED_MESSAGE`); `denied`: permission refused or dismissed, nothing
 * was sent. Throws `PushSetupError` (or a network `TypeError`) when the server step fails.
 */
export async function enablePush(): Promise<PushOutcome> {
  if (!isStandalone() || !pushSupported()) return 'unsupported';
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return 'denied';

  const key = await serverKey();
  const registration = await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();
  if (subscription && !sameKey(subscription.options?.applicationServerKey, key)) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });

  const { endpoint, keys } = subscription.toJSON();
  const res = await authedFetch(SUBSCRIBE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint, keys: { p256dh: keys?.p256dh, auth: keys?.auth } }),
  });
  if (!res.ok) throw new PushSetupError(res.status);
  return 'granted';
}

/** Show `n` on the app icon (0 clears it) where the Badging API exists; silent elsewhere. */
export async function setBadge(n: number): Promise<void> {
  try {
    if (n > 0) await navigator.setAppBadge?.(n);
    else await navigator.clearAppBadge?.();
  } catch {
    // no badge permission or no API: the badge is a nicety
  }
}
