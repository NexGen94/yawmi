// The service worker's `push` and `notificationclick` handlers, kept free of worker globals so
// they can be tested in Node and type-checked under both the DOM and WebWorker libs.
//
// The server sends declarative push messages (`{"web_push": 8030, "notification": {...}}`).
// Safari 18.4+ shows those itself without waking the worker; when a browser hands the worker a
// proposed notification (`event.notification`), it is left to the browser. Every other browser
// runs this fallback, which shows the same notification from the payload. A push must always
// show something (`userVisibleOnly`), so an unreadable payload still shows a neutral one.

const TITLE = 'يومي';
/** The message of a notification the server sent with neither a title nor a body (or none the worker
 *  could read): a title alone says nothing. A noun phrase, so it addresses no one. */
const NEUTRAL_BODY = 'تنبيه جديد';

interface PushData {
  json(): unknown;
}

export interface PushEventLike {
  data: PushData | null;
  waitUntil(promise: Promise<unknown>): void;
  notification?: unknown;
}

export interface NotificationClickLike {
  notification: { data?: unknown; close(): void };
  waitUntil(promise: Promise<unknown>): void;
}

export interface WindowLike {
  url: string;
  navigate?(url: string): Promise<unknown>;
  focus(): Promise<unknown>;
}

/** What the handlers need from the worker (`self.registration`, `self.clients`, `navigator`). */
export interface PushTarget {
  origin: string;
  showNotification(title: string, options: NotificationOptions): Promise<void>;
  setAppBadge?(n: number): Promise<void>;
  windows(): Promise<readonly WindowLike[]>;
  openWindow(url: string): Promise<unknown>;
}

interface Shown {
  title: string;
  options: NotificationOptions;
  badge: number | undefined;
}

const str = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

function read(data: PushData | null): Shown {
  let message: unknown = null;
  try {
    message = data?.json() ?? null;
  } catch {
    message = null;
  }
  const n = (message as { notification?: Record<string, unknown> } | null)?.notification ?? {};
  const body = str(n.body) ?? (str(n.title) === undefined ? NEUTRAL_BODY : undefined);
  const badge = typeof n.app_badge === 'number' && Number.isInteger(n.app_badge) && n.app_badge >= 0 ? n.app_badge : undefined;
  return {
    title: str(n.title) ?? TITLE,
    options: {
      ...(body === undefined ? {} : { body }),
      lang: 'ar',
      dir: 'rtl',
      data: { navigate: str(n.navigate) ?? '/' },
    },
    badge,
  };
}

async function show(shown: Shown, target: PushTarget): Promise<void> {
  await target.showNotification(shown.title, shown.options);
  if (shown.badge === undefined) return;
  try {
    // inside try/await, so a badge API that throws synchronously is caught as well
    await target.setAppBadge?.(shown.badge);
  } catch {
    // no Badging API or no permission: the badge is a nicety
  }
}

export function handlePush(event: PushEventLike, target: PushTarget): void {
  if (event.notification) return; // the browser handles the declarative message itself
  event.waitUntil(show(read(event.data), target));
}

/** Same-origin URL for `navigate`; anything else (another origin, junk) falls back to the root. */
function sameOrigin(navigate: unknown, origin: string): string {
  try {
    const url = new URL(str(navigate) ?? '/', origin);
    if (url.origin === origin) return url.href;
  } catch {
    // not a URL
  }
  return new URL('/', origin).href;
}

async function open(url: string, target: PushTarget): Promise<void> {
  const [window] = await target.windows();
  if (window) {
    try {
      // already there: focus only, since navigate() would reload the app
      if (window.url !== url) {
        if (!window.navigate) throw new TypeError('navigate is not available');
        await window.navigate(url);
      }
      await window.focus();
      return;
    } catch {
      // navigate() rejects for a window this worker does not control (first session after
      // install): open a new one instead
    }
  }
  await target.openWindow(url);
}

export function handleNotificationClick(event: NotificationClickLike, target: PushTarget): void {
  event.notification.close();
  const navigate = (event.notification.data as { navigate?: unknown } | null | undefined)?.navigate;
  event.waitUntil(open(sameOrigin(navigate, target.origin), target));
}
