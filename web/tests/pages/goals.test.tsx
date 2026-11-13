// @vitest-environment happy-dom
import 'fake-indexeddb/auto';

import { fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { IDBFactory } from 'fake-indexeddb';
import { LocationProvider } from 'preact-iso';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readCache, writeCache } from '../../src/data/cache';
import { DomainCards } from '../../src/pages/goals/DomainCards';
import GoalsPage from '../../src/pages/goals/index';
import { setDigits } from '../../src/lib/format';
import { clearOutbox, closeDb } from '../../src/sync/outbox';
import {
  EMPTY_GOALS,
  type GoalsOut,
  goals,
  milestone,
  NOON_RIYADH,
  OUTCOME_TITLES,
} from '../helpers/goals-fixtures';
import { morningEntry, routeFetch, STORY_HABITS, STORY_LOGS, todayOut } from '../helpers/today-fixtures';

vi.mock('../../src/sync/outbox', async (original) => ({
  ...(await original<typeof import('../../src/sync/outbox')>()),
  scheduleFlush: vi.fn(),
}));

const DEFAULT_COLUMNS = {
  outcomes: ['code', 'title', 'completion', 'next_milestone', 'target_date'],
  milestones: ['title', 'outcome_code', 'due_date', 'done', 'cycle_no'],
  cards: ['title', 'status', 'outcome_codes', 'target_date', 'next_step', 'milestones_done'],
};

let fetchMock: ReturnType<typeof vi.fn>;
let patches: unknown[];

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const settings = (columns: Record<string, string[]> = DEFAULT_COLUMNS) => ({
  mission: '',
  vision: '',
  digits: 'latn',
  ai_lines: 2,
  ai_tone: 'direct',
  ai_checkin: 'evening',
  late_notice_enabled: true,
  late_notice_time: '20:00',
  goal_columns: columns,
});

interface Serve {
  goals?: GoalsOut;
  fail?: 'network' | 500;
  /** What PATCH /v1/settings answers with (default: the columns it was sent). */
  patchStatus?: number;
  /** What GET /v1/settings answers with (default 200). */
  settingsStatus?: number;
}

function serve({ goals: data = goals(), fail, patchStatus = 200, settingsStatus = 200 }: Serve = {}): void {
  const rest = vi.fn();
  routeFetch(
    rest,
    {
      habits: STORY_HABITS,
      today: todayOut(),
      logs: STORY_LOGS,
      journal: [morningEntry({ priorities: [{ title: 'أولوية أولى' }, { title: 'أولوية ثانية' }] })],
    },
    {},
  );
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input as Request;
    const url = new URL(request.url);
    if (url.pathname === '/v1/goals') {
      if (fail === 'network') throw new TypeError('Failed to fetch');
      if (fail === 500) return json({ detail: 'خطأ' }, 500);
      return json(data);
    }
    if (url.pathname === '/v1/settings') {
      if (request.method === 'PATCH') {
        const body = (await request.clone().json()) as { goal_columns: Record<string, string[]> };
        patches.push(body);
        return patchStatus === 200 ? json(settings(body.goal_columns)) : json({ detail: 'خطأ' }, patchStatus);
      }
      return settingsStatus === 200 ? json(settings()) : json({ detail: 'خطأ' }, settingsStatus);
    }
    return rest(input, init);
  });
}

beforeEach(() => {
  closeDb();
  Object.assign(globalThis, { indexedDB: new IDBFactory() });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOON_RIYADH));
  fetchMock = vi.fn();
  patches = [];
  vi.stubGlobal('fetch', fetchMock);
  history.replaceState(null, '', '/goals');
});

afterEach(async () => {
  setDigits('latn');
  await clearOutbox().catch(() => undefined);
  closeDb();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  history.replaceState(null, '', '/');
});

async function open(url = '/goals', options: Serve = {}) {
  history.replaceState(null, '', url);
  serve(options);
  const view = render(
    <LocationProvider>
      <GoalsPage />
    </LocationProvider>,
  );
  await screen.findByRole('radiogroup', { name: 'العرض' });
  return view;
}

const setOnline = (online: boolean): void => {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
};
afterEach(() => setOnline(true));

describe('the domain cards', () => {
  const titled: GoalsOut = (() => {
    const base = goals();
    return {
      ...base,
      outcomes: base.outcomes.map((o) => ({ ...o, title: `عنوان مميز ${o.code}` })),
    };
  })();

  it('each card shows the titles of its own outcomes as the server sent them', async () => {
    await open('/goals', { goals: titled });
    const career = screen.getByRole('region', { name: 'المهني' });
    expect(within(career).getByText('عنوان مميز O4')).toBeTruthy();
    expect(within(career).getByText('عنوان مميز O5')).toBeTruthy();
    expect(within(career).queryByText('عنوان مميز O1')).toBeNull();
    expect(within(screen.getByRole('region', { name: 'الصحي' })).getByText('عنوان مميز O1')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'النفسي' })).getByText('عنوان مميز O2')).toBeTruthy();
    const learning = within(screen.getByRole('region', { name: 'العلمي' }));
    expect(learning.getByText('عنوان مميز O6')).toBeTruthy();
    expect(learning.getByText('عنوان مميز O7')).toBeTruthy();
  });

  it('puts the career headline in an isolated left-to-right run', async () => {
    await open();
    const bdi = screen.getByText('Digital Business Transformation & Solutions Management');
    expect(bdi.tagName).toBe('BDI');
    expect(bdi.getAttribute('dir')).toBe('ltr');
    expect(within(screen.getByRole('region', { name: 'المهني' })).getByText(bdi.textContent ?? '')).toBe(bdi);
  });

  it('shows a dash, never 0% or NaN, for an outcome with nothing to measure', () => {
    const { container } = render(
      <DomainCards outcomes={[{ code: 'O1', title: 'الصحة الجسدية', completion: null }]} />,
    );
    const health = within(screen.getByRole('region', { name: 'الصحي' }));
    expect(health.getByText('الصحة الجسدية')).toBeTruthy();
    expect(container.textContent).toContain('—');
    expect(container.textContent).not.toMatch(/NaN|0%/);
  });

  it('shows the completion of an outcome as a percentage', () => {
    render(<DomainCards outcomes={[{ code: 'O1', title: 'الصحة الجسدية', completion: 0.25 }]} />);
    expect(within(screen.getByRole('region', { name: 'الصحي' })).getAllByText('25%').length).toBeGreaterThan(0);
  });

  it('works with the cards of an outcome the server did not send', () => {
    render(<DomainCards outcomes={[]} />);
    expect(screen.getAllByRole('region')).toHaveLength(4);
  });
});

describe('the cycle card', () => {
  it('says the cycle, its theme and the day in it', async () => {
    await open();
    const card = screen.getByRole('region', { name: 'الدورة 1' });
    expect(card.textContent).toContain('التأسيس');
    expect(card.textContent).toContain('اليوم 11 من 57');
  });
});

describe('the outcome tree', () => {
  it('lists the 12 outcomes with their title and acceptance in the head', async () => {
    const { container } = await open();
    const items = container.querySelectorAll('[data-outcome]');
    expect(items).toHaveLength(12);
    const o4 = container.querySelector('[data-outcome="O4"]') as HTMLElement;
    const head = within(o4).getByText(OUTCOME_TITLES.O4 as string).closest('summary') as HTMLElement;
    expect(head.textContent).toContain('معيار قبول O4');
  });

  it('opens on the supporting habits, then the milestones, then the cards', async () => {
    const base = goals();
    const data: GoalsOut = {
      ...base,
      outcomes: base.outcomes.map((o) =>
        o.code === 'O1' ? { ...o, habits: [{ code: 'wake_water', title_ar: 'شرب الماء', adherence: 0.8, total_done: 12 }] } : o,
      ),
    };
    const { container } = await open('/goals', { goals: data });
    const o1 = container.querySelector('[data-outcome="O1"]') as HTMLElement;
    const summary = o1.querySelector('summary') as HTMLElement;
    fireEvent.click(summary);
    const body = o1.querySelector('.disclosure-body') as HTMLElement;
    const text = body.textContent ?? '';
    expect(text.indexOf('شرب الماء')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('فحص الدم السنوي')).toBeGreaterThan(text.indexOf('شرب الماء'));
    expect(text.indexOf('خطة اللياقة')).toBeGreaterThan(text.indexOf('فحص الدم السنوي'));
  });

  it('says a milestone is done or open, and how late a late one is', async () => {
    const { container } = await open();
    const o8 = container.querySelector('[data-outcome="O8"]') as HTMLElement;
    expect(within(o8).getByText('مراجعة الميزانية')).toBeTruthy();
    expect(o8.textContent).toContain('متأخرة يومين');
    const o1 = container.querySelector('[data-outcome="O1"]') as HTMLElement;
    expect(o1.textContent).toContain('منجزة');
  });

  it('links an outcome and its milestones to their detail pages', async () => {
    const { container } = await open();
    const o1 = container.querySelector('[data-outcome="O1"]') as HTMLElement;
    expect(within(o1).getByRole('link', { name: 'تفاصيل المخرج' }).getAttribute('href')).toBe('/goals/O1');
    expect(within(o1).getByRole('link', { name: 'فحص الدم السنوي' }).getAttribute('href')).toBe('/goals/m-blood');
  });
});

describe('the table', () => {
  const headers = (): string[] => screen.getAllByRole('columnheader').map((h) => h.textContent ?? '');

  it('opens on the milestones with their default columns', async () => {
    await open('/goals?view=table');
    expect(headers()).toEqual(['العنوان', 'المخرج', 'الموعد', 'الإنجاز', 'الدورة']);
  });

  it('shows the cards with their target date and next step, a dash when empty', async () => {
    await open('/goals?view=table&table=cards');
    expect(headers()).toEqual(['العنوان', 'الحالة', 'المخرجات', 'الموعد المستهدف', 'الخطوة التالية', 'المحطات المنجزة']);
    const filled = screen.getByText('خطة اللياقة').closest('tr') as HTMLElement;
    expect(filled.textContent).toContain('حجز موعد الفحص');
    expect(filled.textContent).toContain('الخميس، 31 ديسمبر 2026');
    const empty = screen.getByText('مسار الإنجليزية').closest('tr') as HTMLElement;
    expect(within(empty).getAllByText('—')).toHaveLength(2);
  });

  it('switches table through ?table=', async () => {
    await open('/goals?view=table');
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'الجدول' })).getByRole('radio', { name: 'البطاقات' }));
    await waitFor(() => expect(location.search).toContain('table=cards'));
    expect(headers()).toContain('الخطوة التالية');
  });

  it('the chooser shows the evidence column and saves it with one PATCH', async () => {
    await open('/goals?view=table');
    fireEvent.click(screen.getByRole('button', { name: 'الدليل' }));
    await waitFor(() => expect(headers()).toContain('الدليل'));
    expect(patches).toHaveLength(1);
    const sent = (patches[0] as { goal_columns: Record<string, string[]> }).goal_columns;
    expect(sent.milestones).toEqual([...DEFAULT_COLUMNS.milestones, 'evidence']);
    // the server replaces the whole object, so the other two tables are sent as they are
    expect(sent.outcomes).toEqual(DEFAULT_COLUMNS.outcomes);
    expect(sent.cards).toEqual(DEFAULT_COLUMNS.cards);
    expect(screen.getByText('نتيجة المختبر')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'الدليل' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('writes the saved choice to the offline copy of the settings', async () => {
    await open('/goals?view=table');
    fireEvent.click(screen.getByRole('button', { name: 'الدليل' }));
    await waitFor(() => expect(patches).toHaveLength(1));
    await waitFor(async () => {
      const cached = await readCache<{ goal_columns: Record<string, string[]> }>('settings');
      expect(cached?.value.goal_columns.milestones).toContain('evidence');
    });
  });

  it('says the columns could not be loaded, not that a connection is needed, when online and the settings failed', async () => {
    await open('/goals?view=table', { settingsStatus: 500 });
    await screen.findByText('تعذّر تحميل الأعمدة');
    expect(screen.queryByText('يحتاج اتصالاً')).toBeNull();
    expect((screen.getByRole('button', { name: 'الدليل' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('hiding a column takes it away', async () => {
    await open('/goals?view=table');
    fireEvent.click(screen.getByRole('button', { name: 'الدورة' }));
    await waitFor(() => expect(headers()).not.toContain('الدورة'));
    expect((patches[0] as { goal_columns: Record<string, string[]> }).goal_columns.milestones).toEqual([
      'title',
      'outcome_code',
      'due_date',
      'done',
    ]);
  });

  it('keeps the table as it was, and says so, when the save is refused', async () => {
    await open('/goals?view=table', { patchStatus: 500 });
    fireEvent.click(screen.getByRole('button', { name: 'الدليل' }));
    await screen.findByText('تعذّر حفظ الأعمدة');
    expect(headers()).not.toContain('الدليل');
  });

  it('is disabled without a connection, and says it needs one', async () => {
    setOnline(false);
    await open('/goals?view=table');
    const chip = screen.getByRole('button', { name: 'الدليل' }) as HTMLButtonElement;
    expect(chip.disabled).toBe(true);
    expect(screen.getByText('يحتاج اتصالاً')).toBeTruthy();
    fireEvent.click(chip);
    expect(patches).toHaveLength(0);
  });

  it('the last column cannot be taken away', async () => {
    await open('/goals?view=table', {});
    for (const name of ['المخرج', 'الموعد', 'الإنجاز', 'الدورة']) {
      fireEvent.click(screen.getByRole('button', { name }));
      await waitFor(() => expect(headers()).not.toContain(name));
    }
    expect((screen.getByRole('button', { name: 'العنوان' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('is operated by the keyboard: a chip is a button reached by Tab', async () => {
    await open('/goals?view=table');
    const chip = screen.getByRole('button', { name: 'الدليل' });
    expect(chip.tagName).toBe('BUTTON');
    expect(chip.getAttribute('tabindex')).not.toBe('-1');
  });
});

describe('الأقرب استحقاقاً', () => {
  it('lists the late ones first with how late, then the coming ones by date with how far', async () => {
    await open('/goals?view=due');
    const rows = Array.from(document.querySelectorAll('[data-due]')).map((r) => r.textContent ?? '');
    expect(rows[0]).toContain('مراجعة الميزانية');
    expect(rows[0]).toContain('متأخرة يومين');
    expect(rows[1]).toContain('فحص الدم السنوي');
    expect(rows[1]).toContain('بعد يومين');
    expect(rows[3]).toContain('حجز دورة الإنجليزية');
    expect(rows[3]).toContain('بعد 5 أيام');
    expect(rows[1]).toContain('الخميس، 12 نوفمبر 2026');
  });

  it('says there is nothing due when there is nothing', async () => {
    await open('/goals?view=due', { goals: goals({ milestones: [milestone('a', 'منجزة', { done: true, due_date: '2026-11-01' })] }) });
    expect(screen.getByText('لا شيء مستحق')).toBeTruthy();
  });
});

describe('the horizons', () => {
  it('shows the five lines with the words of the design', async () => {
    await open('/goals?view=horizons');
    await waitFor(() => expect(screen.getByText(/أولويتان مفتوحتان/)).toBeTruthy());
    const lines = Array.from(document.querySelectorAll('[data-horizon]')).map((l) => l.textContent);
    expect(lines).toEqual([
      'اليوم: أولويتان مفتوحتان، و3 عادات باقية',
      'الأسبوع: محطتان مستحقتان، أقربها فحص الدم السنوي',
      'الشهر: 4 محطات مستحقة',
      'الدورة 1: اليوم 11 من 57 · التأسيس',
      'الخطة: 3 من 122 محطة · 1877 يوماً حتى الأربعاء، 31 ديسمبر 2031',
    ]);
  });

  it('a line with no data says there is nothing due', async () => {
    await open('/goals?view=horizons', {
      goals: goals({ milestones: [], cards: [] }),
    });
    await waitFor(() => expect(document.querySelectorAll('[data-horizon]')).toHaveLength(5));
    expect(document.querySelector('[data-horizon="week"]')?.textContent).toBe('الأسبوع: لا شيء مستحق');
    expect(document.querySelector('[data-horizon="plan"]')?.textContent).toBe('الخطة: لا شيء مستحق');
  });
});

describe('the timeline view', () => {
  it('draws the chart with its Arabic label', async () => {
    await open('/goals?view=timeline');
    const svg = screen.getByRole('img', { name: /الخط الزمني/ });
    expect(svg.getAttribute('aria-label')).toContain('3 من 122');
  });
});

describe('the view switch', () => {
  it('never scrolls the window: not on load, and not when the view changes', async () => {
    const intoView = vi.fn();
    const windowScroll = vi.fn();
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: intoView });
    vi.stubGlobal('scrollTo', windowScroll);
    await open('/goals?view=timeline');
    await new Promise((r) => setTimeout(r, 50));
    expect(intoView).not.toHaveBeenCalled();
    expect(windowScroll).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('radio', { name: 'الآفاق' }));
    await waitFor(() => expect(location.search).toContain('view=horizons'));
    expect(intoView).not.toHaveBeenCalled();
    expect(windowScroll).not.toHaveBeenCalled();
  });

  it('centres the chosen chip inside the switch itself, when the view changes', async () => {
    await open('/goals?view=tree');
    const box = document.querySelector('.goals-switch') as HTMLElement;
    const sets: number[] = [];
    let left = 0;
    Object.defineProperty(box, 'scrollLeft', { configurable: true, get: () => left, set: (v: number) => { left = v; sets.push(v); } });
    expect(sets).toEqual([]);
    fireEvent.click(screen.getByRole('radio', { name: 'الآفاق' }));
    await waitFor(() => expect(sets.length).toBeGreaterThan(0));
  });

  it('writes the view in ?view= and opens the tree by default', async () => {
    await open();
    expect(screen.getByRole('radio', { name: 'الشجرة' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('radio', { name: 'الآفاق' }));
    await waitFor(() => expect(location.search).toContain('view=horizons'));
    expect(screen.getByRole('radio', { name: 'الآفاق' }).getAttribute('aria-checked')).toBe('true');
  });

  it('falls back to the tree for a view it does not know', async () => {
    await open('/goals?view=nonsense');
    expect(screen.getByRole('radio', { name: 'الشجرة' }).getAttribute('aria-checked')).toBe('true');
  });
});

describe('pending edits', () => {
  it('shows «تعديلات معلّقة: 2» beside the title', async () => {
    await open('/goals', { goals: goals({ pending_edits: 2 }) });
    expect(screen.getByRole('button', { name: 'تعديلات معلّقة: 2' })).toBeTruthy();
  });

  it('shows nothing when there is none', async () => {
    await open('/goals', { goals: goals({ pending_edits: 0 }) });
    expect(screen.queryByText(/تعديلات معلّقة/)).toBeNull();
  });

  it('opens the list of what is waiting, with the field and a link to it', async () => {
    const base = goals({ pending_edits: 2 });
    const data: GoalsOut = {
      ...base,
      milestones: base.milestones.map((m) => (m.page_id === 'm-blood' ? { ...m, pending: ['due_date'] } : m)),
      cards: base.cards.map((c) => (c.page_id === 'c-health' ? { ...c, pending: ['status'] } : c)),
    };
    await open('/goals', { goals: data });
    fireEvent.click(screen.getByRole('button', { name: 'تعديلات معلّقة: 2' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('link', { name: /فحص الدم السنوي/ }).getAttribute('href')).toBe('/goals/m-blood');
    expect(dialog.textContent).toContain('الموعد');
    expect(within(dialog).getByRole('link', { name: /خطة اللياقة/ }).getAttribute('href')).toBe('/goals/c-health');
    expect(dialog.textContent).toContain('الحالة');
  });
});

describe('the four states', () => {
  it('loading: skeleton and aria-busy', async () => {
    fetchMock.mockImplementation(() => new Promise<Response>(() => undefined));
    const { container } = render(
      <LocationProvider>
        <GoalsPage />
      </LocationProvider>,
    );
    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'الأهداف' })).toBeTruthy();
  });

  it('empty mirror: says Notion has not been copied, without an error', async () => {
    serve({ goals: EMPTY_GOALS });
    render(
      <LocationProvider>
        <GoalsPage />
      </LocationProvider>,
    );
    await screen.findByText('لم تُنسخ الخطة من Notion بعد');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('تعذّر التحميل')).toBeNull();
  });

  it('the mirror Notion has not filled yet (seeded outcomes and cycles, no milestones or cards, never synced) is the empty state', async () => {
    serve({ goals: goals({ milestones: [], cards: [], synced_at: null }) });
    const { container } = render(
      <LocationProvider>
        <GoalsPage />
      </LocationProvider>,
    );
    await screen.findByText('لم تُنسخ الخطة من Notion بعد');
    expect(screen.queryByRole('radiogroup', { name: 'العرض' })).toBeNull();
    expect(container.textContent).not.toContain('لا شيء مستحق');
    expect(container.querySelectorAll('[data-outcome]')).toHaveLength(0);
  });

  it('a synced mirror with no milestones is not the empty state', async () => {
    await open('/goals?view=horizons', { goals: goals({ milestones: [], cards: [] }) });
    expect(screen.queryByText('لم تُنسخ الخطة من Notion بعد')).toBeNull();
  });

  it('a null indicator is a dash everywhere, never 0% or NaN', async () => {
    const base = goals();
    const nothing: GoalsOut = {
      ...base,
      milestones: [],
      cards: [],
      outcomes: base.outcomes.map((o) => ({ ...o, milestones_total: 0, milestones_done: 0, completion: null })),
    };
    const { container } = await open('/goals', { goals: nothing });
    expect(container.textContent).not.toMatch(/NaN|0%/);
    expect(container.textContent).toContain('—');
  });

  it('error: «تعذّر التحميل» with a retry that reads again', async () => {
    history.replaceState(null, '', '/goals');
    serve({ fail: 500 });
    render(
      <LocationProvider>
        <GoalsPage />
      </LocationProvider>,
    );
    await screen.findByText('تعذّر التحميل');
    expect(screen.queryByText(/500|HTTP/)).toBeNull();
    serve();
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    await screen.findByRole('radiogroup', { name: 'العرض' });
  });

  it('offline with a saved copy: the copy and the badge', async () => {
    await writeCache('goals', goals());
    serve({ fail: 'network' });
    render(
      <LocationProvider>
        <GoalsPage />
      </LocationProvider>,
    );
    await screen.findByText('نسخة محفوظة · بلا اتصال');
    expect(screen.getByRole('region', { name: 'الصحي' })).toBeTruthy();
  });

  it('offline with no copy: «لا نسخة محفوظة بعد»', async () => {
    serve({ fail: 'network' });
    render(
      <LocationProvider>
        <GoalsPage />
      </LocationProvider>,
    );
    await screen.findByText('لا نسخة محفوظة بعد');
    expect(screen.queryByRole('radiogroup', { name: 'العرض' })).toBeNull();
  });
});

describe('what the page does not do', () => {
  it('has no delete, and no edit field: the views are read only', async () => {
    await open('/goals?view=table');
    expect(screen.queryByRole('button', { name: /حذف/ })).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });
});
