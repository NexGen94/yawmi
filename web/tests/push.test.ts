import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearAccessToken, setAccessToken } from '../src/api/auth';
import { handleNotificationClick, handlePush, type PushTarget } from '../src/push/handlers';
import { enablePush, PUSH_UNSUPPORTED_MESSAGE, setBadge } from '../src/push/subscribe';

// A throwaway uncompressed P-256 point (65 bytes, 0x04 first); it is never used to sign anything.
const SERVER_KEY = new Uint8Array(65).fill(7);
SERVER_KEY[0] = 4;
const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let fetchMock: ReturnType<typeof vi.fn>;
let requestPermission: ReturnType<typeof vi.fn>;
let subscribe: ReturnType<typeof vi.fn>;
let standalone: boolean;

const subscription = {
  endpoint: 'https://web.push.apple.com/abc',
  options: { applicationServerKey: null },
  toJSON: () => ({ endpoint: 'https://web.push.apple.com/abc', keys: { p256dh: 'P256', auth: 'AUTH' } }),
};

beforeEach(() => {
  standalone = true;
  setAccessToken('tok');
  fetchMock = vi.fn(async (input: RequestInfo | URL) =>
    String(input) === '/v1/push/vapid-public-key' ? json({ key: b64url(SERVER_KEY) }) : new Response(null, { status: 204 }),
  );
  requestPermission = vi.fn(async () => 'granted');
  subscribe = vi.fn(async () => subscription);
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(display-mode: standalone)' && standalone }));
  vi.stubGlobal('Notification', { requestPermission });
  vi.stubGlobal('PushManager', function PushManager() {});
  vi.stubGlobal('navigator', {
    serviceWorker: { ready: Promise.resolve({ pushManager: { getSubscription: async () => null, subscribe } }) },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearAccessToken();
});

describe('enablePush', () => {
  it('outside standalone mode returns unsupported without asking for permission', async () => {
    standalone = false;
    expect(await enablePush()).toBe('unsupported');
    expect(requestPermission).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(PUSH_UNSUPPORTED_MESSAGE).toBe('تُفعَّل التذكيرات بعد إضافة يومي إلى الشاشة الرئيسية');
  });

  it('without the push APIs returns unsupported without asking for permission', async () => {
    vi.stubGlobal('PushManager', undefined);
    expect(await enablePush()).toBe('unsupported');
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it.each(['denied', 'default'])('a %s permission returns denied without calling the server', async (answer) => {
    requestPermission.mockResolvedValueOnce(answer);
    expect(await enablePush()).toBe('denied');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('asks for permission before any await, then subscribes and sends the endpoint and both keys', async () => {
    const order: string[] = [];
    requestPermission.mockImplementationOnce(async () => {
      order.push('permission');
      return 'granted';
    });
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      order.push(`${init?.method ?? 'GET'} ${String(input)}`);
      return String(input) === '/v1/push/vapid-public-key' ? json({ key: b64url(SERVER_KEY) }) : new Response(null, { status: 204 });
    });

    expect(await enablePush()).toBe('granted');

    expect(order).toEqual(['permission', 'GET /v1/push/vapid-public-key', 'POST /v1/push/subscribe']);
    const options = subscribe.mock.calls[0]?.[0] as PushSubscriptionOptionsInit;
    expect(options.userVisibleOnly).toBe(true);
    expect(Array.from(options.applicationServerKey as Uint8Array)).toEqual(Array.from(SERVER_KEY));
    const post = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(String(post[1].body))).toEqual({
      endpoint: 'https://web.push.apple.com/abc',
      keys: { p256dh: 'P256', auth: 'AUTH' },
    });
    expect(new Headers(post[1].headers).get('Authorization')).toBe('Bearer tok');
  });

  it('reuses an existing subscription made with the same key', async () => {
    const existing = { ...subscription, options: { applicationServerKey: SERVER_KEY.buffer } };
    vi.stubGlobal('navigator', {
      serviceWorker: { ready: Promise.resolve({ pushManager: { getSubscription: async () => existing, subscribe } }) },
    });
    expect(await enablePush()).toBe('granted');
    expect(subscribe).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws when the server refuses the key or the subscription', async () => {
    fetchMock.mockResolvedValueOnce(json({ detail: 'الإشعارات غير مفعّلة' }, 503));
    await expect(enablePush()).rejects.toThrow();
  });
});

describe('setBadge', () => {
  it('sets or clears the app badge when the API exists and is silent otherwise', async () => {
    const setAppBadge = vi.fn(async () => undefined);
    const clearAppBadge = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { setAppBadge, clearAppBadge });
    await setBadge(3);
    await setBadge(0);
    expect(setAppBadge).toHaveBeenCalledWith(3);
    expect(clearAppBadge).toHaveBeenCalledTimes(1);
    vi.stubGlobal('navigator', {});
    await expect(setBadge(2)).resolves.toBeUndefined();
  });
});

describe('service worker handlers', () => {
  const target = (): PushTarget & {
    shown: Array<[string, NotificationOptions]>;
    badges: number[];
    opened: string[];
    focused: string[];
  } => {
    const t = {
      shown: [] as Array<[string, NotificationOptions]>,
      badges: [] as number[],
      opened: [] as string[],
      focused: [] as string[],
      origin: 'https://yawmi.example',
      showNotification: async (title: string, options: NotificationOptions) => void t.shown.push([title, options]),
      setAppBadge: async (n: number) => void t.badges.push(n),
      windows: async () => [{ url: 'https://yawmi.example/x', navigate: async (u: string) => void t.focused.push(u), focus: async () => undefined }],
      openWindow: async (url: string) => void t.opened.push(url),
    };
    return t;
  };
  const run = async (fn: (wait: (p: Promise<unknown>) => void) => void): Promise<void> => {
    const pending: Array<Promise<unknown>> = [];
    fn((p) => pending.push(p));
    await Promise.all(pending);
  };
  const message = {
    web_push: 8030,
    notification: { title: 'يومي', body: 'المشي', navigate: '/', app_badge: 2, lang: 'ar', dir: 'rtl' },
  };

  it('push shows the declarative notification from the payload itself', async () => {
    const t = target();
    await run((waitUntil) => handlePush({ data: { json: () => message }, waitUntil }, t));
    expect(t.shown).toEqual([['يومي', { body: 'المشي', lang: 'ar', dir: 'rtl', data: { navigate: '/' } }]]);
    expect(t.badges).toEqual([2]);
  });

  it('push does nothing when the browser already handles the declarative message', async () => {
    const t = target();
    await run((waitUntil) => handlePush({ data: { json: () => message }, waitUntil, notification: {} }, t));
    expect(t.shown).toEqual([]);
  });

  it('push with an unreadable payload still shows a neutral notification', async () => {
    const t = target();
    const bad = { json: () => { throw new SyntaxError('x'); } };
    await run((waitUntil) => handlePush({ data: bad, waitUntil }, t));
    // A notification with a title alone says nothing: the neutral one has a message too (Task 24).
    expect(t.shown).toEqual([['يومي', { body: 'تنبيه جديد', lang: 'ar', dir: 'rtl', data: { navigate: '/' } }]]);
  });

  it('a payload with no notification at all is neutral too, and one with a title keeps its own words', async () => {
    const t = target();
    await run((waitUntil) => handlePush({ data: { json: () => ({}) }, waitUntil }, t));
    await run((waitUntil) => handlePush({ data: { json: () => ({ notification: { title: 'المتأخر' } }) }, waitUntil }, t));
    expect(t.shown).toEqual([
      ['يومي', { body: 'تنبيه جديد', lang: 'ar', dir: 'rtl', data: { navigate: '/' } }],
      ['المتأخر', { lang: 'ar', dir: 'rtl', data: { navigate: '/' } }],
    ]);
  });

  it('notificationclick opens navigate in an open window, else a new one, and never another origin', async () => {
    const close = vi.fn();
    const t = target();
    await run((waitUntil) => handleNotificationClick({ notification: { data: { navigate: '/' }, close }, waitUntil }, t));
    expect(close).toHaveBeenCalled();
    expect(t.focused).toEqual(['https://yawmi.example/']);

    const empty = { ...target(), windows: async () => [] };
    await run((waitUntil) =>
      handleNotificationClick({ notification: { data: { navigate: 'https://evil.example/' }, close }, waitUntil }, empty),
    );
    expect(empty.opened).toEqual(['https://yawmi.example/']);
  });
});

describe('fix round 1', () => {
  const run = async (fn: (wait: (p: Promise<unknown>) => void) => void): Promise<void> => {
    const pending: Array<Promise<unknown>> = [];
    fn((p) => pending.push(p));
    await Promise.all(pending);
  };
  const base = (): PushTarget & { shown: string[]; opened: string[] } => {
    const t = {
      shown: [] as string[],
      opened: [] as string[],
      origin: 'https://yawmi.example',
      showNotification: async (title: string) => void t.shown.push(title),
      windows: async () => [] as never[],
      openWindow: async (url: string) => void t.opened.push(url),
    };
    return t;
  };
  const message = { web_push: 8030, notification: { title: 'يومي', body: 'المشي', navigate: '/', app_badge: 2 } };

  it('a badge API that throws synchronously does not reject the push handling', async () => {
    const t = {
      ...base(),
      setAppBadge: (): Promise<void> => {
        throw new TypeError('no badging here');
      },
    };
    await expect(run((waitUntil) => handlePush({ data: { json: () => message }, waitUntil }, t))).resolves.toBeUndefined();
    expect(t.shown).toEqual(['يومي']);
  });

  it('a window this worker does not control: navigate rejects, so a new window opens', async () => {
    const focus = vi.fn(async () => undefined);
    const t = {
      ...base(),
      windows: async () => [{ url: 'https://yawmi.example/x', navigate: async () => Promise.reject(new TypeError('not controlled')), focus }],
    };
    await run((waitUntil) => handleNotificationClick({ notification: { data: { navigate: '/' }, close: () => undefined }, waitUntil }, t));
    expect(t.opened).toEqual(['https://yawmi.example/']);
  });

  it('a window already at the target is only focused, not navigated (no reload)', async () => {
    const navigate = vi.fn(async () => undefined);
    const focus = vi.fn(async () => undefined);
    const t = { ...base(), windows: async () => [{ url: 'https://yawmi.example/', navigate, focus }] };
    await run((waitUntil) => handleNotificationClick({ notification: { data: { navigate: '/' }, close: () => undefined }, waitUntil }, t));
    expect(navigate).not.toHaveBeenCalled();
    expect(focus).toHaveBeenCalledTimes(1);
    expect(t.opened).toEqual([]);
  });

  it('an existing subscription without options is replaced instead of throwing', async () => {
    const unsubscribe = vi.fn(async () => true);
    const existing = { ...subscription, options: undefined, unsubscribe };
    vi.stubGlobal('navigator', {
      serviceWorker: { ready: Promise.resolve({ pushManager: { getSubscription: async () => existing, subscribe } }) },
    });
    expect(await enablePush()).toBe('granted');
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledTimes(1);
  });
});
