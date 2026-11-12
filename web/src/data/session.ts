import { getLastDeviceId, logout as apiLogout, onUnauthorized, pair } from '../api/auth';
import { navigate } from '../lib/navigate';
import { clearOutbox, flush, pending } from '../sync/outbox';
import { clearCache, kvDelete, kvGet, kvSet } from './cache';

const DEVICE_ID_KEY = 'device_id';
const DEVICE_NAME_KEY = 'device_name';

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
 * 1. Flushes any pending events. If any remain, prompts user for confirmation.
 * 2. Calls POST /v1/auth/logout on the server.
 * 3. Discards the in-memory access token and clears cached responses and session in kv.
 * 4. Navigates to /pair.
 */
export async function logout(): Promise<void> {
  const initialPending = await pending();
  if (initialPending > 0) {
    try {
      await flush();
    } catch {
      // ignore flush failure and check remaining
    }

    const remaining = await pending();
    if (remaining > 0) {
      const message = `في الطابور ${remaining} تسجيلات لم تُرسل. الخروج يحذفها.`;
      const confirmed = typeof window !== 'undefined' ? window.confirm(message) : true;
      if (!confirmed) {
        return;
      }
      await clearOutbox();
    }
  }

  try {
    await apiLogout();
  } catch {
    // Access token is cleared by apiLogout even if the request fails
  }

  await clearCache();
  await kvDelete(DEVICE_ID_KEY);
  await kvDelete(DEVICE_NAME_KEY);

  if (typeof window !== 'undefined') {
    navigate('/pair');
  }
}

// Redirect to /pair whenever an Unauthorized error occurs anywhere in the app
if (typeof window !== 'undefined') {
  onUnauthorized(() => {
    navigate('/pair');
  });
}
