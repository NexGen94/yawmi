import { getLastDeviceId, logout as apiLogout, LogoutError, pair } from '../api/auth';
import { navigate } from '../lib/navigate';
import { clearOutbox, clearQuarantine, flush, pending } from '../sync/outbox';
import { clearCache, kvDelete, kvGet, kvSet } from './cache';

const DEVICE_ID_KEY = 'device_id';
const DEVICE_NAME_KEY = 'device_name';

function formatUnsentCountMessage(count: number): string {
  let countStr = `${count} تسجيلات`;
  if (count === 1) countStr = 'تسجيل واحد';
  else if (count === 2) countStr = 'تسجيلان';
  else if (count >= 3 && count <= 10) countStr = `${count} تسجيلات`;
  else if (count >= 11) countStr = `${count} تسجيلاً`;
  return `في الطابور ${countStr} لم تُرسل. الخروج يحذفها.`;
}

/**
 * Check whether this device has an established session stored in kv.
 */
export async function isPaired(): Promise<boolean> {
  const deviceId = await kvGet<string>(DEVICE_ID_KEY);
  return Boolean(deviceId);
}

/**
 * Pairs this device using a one-time code.
 * Stores device_id in `kv` and names the device «متصفح الحاسوب» (width >= 900) or «متصفح الجوال».
 */
export async function pairDevice(code: string): Promise<void> {
  const isDesktop = typeof window !== 'undefined' ? window.innerWidth >= 900 : true;
  const deviceName = isDesktop ? 'متصفح الحاسوب' : 'متصفح الجوال';

  await pair(code, deviceName);

  const deviceId = getLastDeviceId();
  if (deviceId) {
    await kvSet(DEVICE_ID_KEY, deviceId);
  }
  await kvSet(DEVICE_NAME_KEY, deviceName);
}

/**
 * Logout of this device:
 * 1. Checks connectivity: signing out requires a connection.
 * 2. Flushes any pending events. If any remain, prompts user for confirmation.
 * 3. Calls POST /v1/auth/logout on the server. On failure, stays signed in and keeps local data.
 * 4. Only after server confirmation: clears outbox, quarantine, cache, and session in kv.
 * 5. Navigates to /pair.
 */
export async function logout(): Promise<void> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    throw new LogoutError('يحتاج اتصالاً');
  }

  let confirmedPendingDiscard = false;
  const initialPending = await pending();
  if (initialPending > 0) {
    try {
      await flush();
    } catch {
      // ignore flush failure and check remaining
    }

    const remaining = await pending();
    if (remaining > 0) {
      const message = formatUnsentCountMessage(remaining);
      const confirmed = typeof window !== 'undefined' ? window.confirm(message) : true;
      if (!confirmed) {
        return;
      }
      confirmedPendingDiscard = true;
    }
  }

  // Server logout: throws LogoutError on failure
  await apiLogout();

  // Wipe local data only after server confirmed:
  if (confirmedPendingDiscard) {
    await clearOutbox();
  }
  await clearQuarantine();
  await clearCache();
  await kvDelete(DEVICE_ID_KEY);
  await kvDelete(DEVICE_NAME_KEY);

  if (typeof window !== 'undefined') {
    navigate('/pair');
  }
}
