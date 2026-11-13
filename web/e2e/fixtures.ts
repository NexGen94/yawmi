import { expect, test as base, type APIRequestContext, type Page } from '@playwright/test';

import { acquire } from './exclusive';
import { PORTS } from './ports';

/** The test API, by address (not through the web proxy): the suite's own server on this machine. */
export const API_URL = `http://127.0.0.1:${PORTS.api}`;

/** How long a saved entry may take to reach the server: the app sends the outbox five seconds after
 *  a save (the undo window), and a slow machine needs some room besides. */
export const SYNC_TIMEOUT = 20_000;

export type ProjectName = 'desktop' | 'mobile';

/** Values and habits of one Playwright project. The two projects share one database, so they never
 *  share a habit or a value: no test depends on what the other project did. */
export interface ProjectData {
  /** The planned minutes the morning chooses. */
  plannedMinutes: number;
  /** The mood score (1 to 5) the evening chooses. */
  mood: number;
  /** A yes-or-no habit seeded for this project. */
  tickCode: string;
  /** A duration habit (minutes) seeded for this project. */
  minutesCode: string;
}

export const PROJECT_DATA: Readonly<Record<ProjectName, ProjectData>> = {
  desktop: { plannedMinutes: 90, mood: 4, tickCode: 'e2e_tick_desktop', minutesCode: 'e2e_minutes_desktop' },
  mobile: { plannedMinutes: 120, mood: 5, tickCode: 'e2e_tick_mobile', minutesCode: 'e2e_minutes_mobile' },
};

/** A fresh one-time web pairing code from the test server's own route (it exists only there). The
 *  suite never makes a failed pairing: the server closes pairing after 20 failures in ten minutes. */
export async function newPairCode(request: APIRequestContext): Promise<string> {
  const res = await request.post(`${API_URL}/__e2e/pair-code`);
  expect(res.ok(), 'POST /__e2e/pair-code').toBe(true);
  const body = (await res.json()) as { code: string };
  return body.code;
}

/** Reads from the API as a device of its own, so a test can check what reached the server. */
export interface Api {
  get<T>(path: string): Promise<T>;
  /** A write as the same device (a consent, a deletion): the status is checked, the body returned. */
  send<T = unknown>(method: 'PUT' | 'POST' | 'DELETE', path: string, data?: unknown): Promise<T>;
}

async function pairedApi(request: APIRequestContext): Promise<Api> {
  const code = await newPairCode(request);
  const res = await request.post(`${API_URL}/v1/devices/pair`, {
    data: { code, name: 'قراءة الاختبار', kind: 'web' },
  });
  expect(res.ok(), 'POST /v1/devices/pair').toBe(true);
  const { access_token: token } = (await res.json()) as { access_token: string };
  return {
    async get<T>(path: string): Promise<T> {
      const read = await request.get(`${API_URL}${path}`, { headers: { Authorization: `Bearer ${token}` } });
      expect(read.ok(), `GET ${path}`).toBe(true);
      return (await read.json()) as T;
    },
    async send<T>(method: 'PUT' | 'POST' | 'DELETE', path: string, data?: unknown): Promise<T> {
      const res = await request.fetch(`${API_URL}${path}`, { method, data, headers: { Authorization: `Bearer ${token}` } });
      expect(res.ok(), `${method} ${path}`).toBe(true);
      return (res.status() === 204 ? undefined : await res.json()) as T;
    },
  };
}

/** The evening form open for writing. A day that is already closed (an earlier test closed it: the two
 *  projects share one user) opens as a read-only summary with «تعديل الإغلاق»; this opens the form. */
export async function openEveningForm(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: 'يومية المساء' })).toBeVisible();
  const reopen = page.getByRole('button', { name: 'تعديل الإغلاق' });
  if (await reopen.isVisible()) await reopen.click();
  await expect(page.getByRole('button', { name: 'إغلاق اليوم' })).toBeVisible();
}

/** Today's date in Riyadh, `YYYY-MM-DD`: the plan's day, whatever the machine's zone. */
export function riyadhToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' }).format(new Date());
}

interface Fixtures {
  /** A page whose device was paired just now with a fresh code, ending on `/`. */
  paired: Page;
  api: Api;
  projectName: ProjectName;
}

export const test = base.extend<Fixtures>({
  projectName: async ({}, use, testInfo) => {
    await use(testInfo.project.name as ProjectName);
  },
  api: async ({ request }, use) => {
    await use(await pairedApi(request));
  },
  paired: async ({ page, request }, use) => {
    const code = await newPairCode(request);
    await page.goto('/pair');
    await page.getByLabel('كود الإقران').fill(code);
    await page.getByRole('button', { name: 'إقران هذا الجهاز' }).click();
    await page.waitForURL((url) => url.pathname === '/');
    await expect(page.getByRole('heading', { level: 1, name: 'الرئيسية' })).toBeVisible();
    await use(page);
  },
});

/** `test` for a spec that changes what every device of the user shares (the AI consent and memory):
 *  each of its tests holds a lock for the API it talks to, so that two workers never withdraw the
 *  consent under each other (the flake of ask.spec under `--workers=2` or more). */
export const sharedStateTest = test.extend<{ sharedState: void }>({
  sharedState: [
    async ({}, use) => {
      const release = await acquire(`state-${PORTS.api}`);
      try {
        await use();
      } finally {
        await release();
      }
    },
    // Waiting for the lock is not the test's time: the fixture has its own timeout.
    { auto: true, timeout: 12 * 60_000 },
  ],
});

export { expect };
