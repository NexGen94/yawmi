// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { emptyForm, fromHabit, withDuration, withType, type HabitForm } from '../../src/habits/form';
import { saveHabit, TIMEOUT_MESSAGE } from '../../src/habits/save';
import type { HabitOut } from '../../src/habits/types';
import { habit } from '../helpers/today-fixtures';

const TODAY = '2026-11-10';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

interface Call {
  method: string;
  path: string;
  body: unknown;
}

let calls: Call[];
let fetchMock: ReturnType<typeof vi.fn>;

/** Answers by `METHOD path`; every request is recorded with its decoded body. */
function serve(answers: Record<string, () => Response | Promise<Response>>): void {
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const request = input as Request;
    const path = new URL(request.url).pathname;
    const text = await request.clone().text();
    calls.push({ method: request.method, path, body: text === '' ? undefined : JSON.parse(text) });
    const answer = answers[`${request.method} ${path}`];
    return answer ? answer() : json({ detail: 'not found' }, 404);
  });
}

const stored = (over: Partial<HabitOut> = {}): HabitOut =>
  habit('u_1', 'قراءة', { created_by: 'user', kind: 'duration', unit: 'min', target_per_period: 20, ...over });

const reading = (over: Partial<HabitForm> = {}): HabitForm => ({
  ...emptyForm(TODAY),
  title_ar: 'قراءة',
  kind: 'duration',
  unit: 'min',
  target_per_period: 20,
  ...over,
});

beforeEach(() => {
  calls = [];
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-10T09:00:00Z'));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('saveHabit: a new habit', () => {
  it('posts the habit and returns what the server stored', async () => {
    const saved = stored();
    serve({ 'POST /v1/habits': () => json(saved, 201) });
    const result = await saveHabit(withDuration(reading({ start_day: TODAY }), 30));
    expect(result).toEqual({ ok: true, habit: saved });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toMatchObject({
      title_ar: 'قراءة',
      kind: 'duration',
      unit: 'min',
      target_per_period: 20,
      period: 'day',
      start_day: TODAY,
      end_day: '2026-12-09',
    });
  });

  it('does not ask the server when the form is invalid, and says which field', async () => {
    serve({});
    const result = await saveHabit(reading({ title_ar: ' ' }));
    expect(result).toMatchObject({ ok: false, kind: 'validation' });
    expect(result.ok === false && result.errors?.title_ar).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  it('checks the end against today when the start is left empty (it needs today)', async () => {
    serve({});
    const result = await saveHabit(reading({ start_day: null, duration: 'custom', end_day: '2026-11-01' }));
    expect(result).toMatchObject({ ok: false, kind: 'validation' });
    expect(calls).toHaveLength(0);
  });

  it('is «offline» without a request when the device has no connection', async () => {
    serve({});
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    expect(await saveHabit(reading())).toEqual({ ok: false, kind: 'offline' });
    expect(calls).toHaveLength(0);
  });

  it('is «offline» when the network fails', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    expect(await saveHabit(reading())).toEqual({ ok: false, kind: 'offline' });
  });

  it('a 422 the server gives is field errors by the name it sends', async () => {
    serve({
      'POST /v1/habits': () =>
        json({ detail: 'طلب غير صالح', errors: [{ loc: ['body', 'target_per_period'], type: 'x' }] }, 422),
    });
    const result = await saveHabit(reading());
    expect(result).toMatchObject({ ok: false, kind: 'validation' });
    expect(result.ok === false && Object.keys(result.errors ?? {})).toEqual(['target_per_period']);
  });

  it('a 422 whose body read times out is «timeout» with no field errors (N-2)', async () => {
    serve({
      'POST /v1/habits': () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new DOMException('The operation timed out.', 'TimeoutError'));
            },
          }),
          { status: 422 },
        ),
    });
    const result = await saveHabit(reading());
    expect(result).toEqual({ ok: false, kind: 'timeout' });
  });

  it('a request that times out is «timeout»', async () => {
    fetchMock.mockRejectedValue(new DOMException('The operation timed out.', 'TimeoutError'));
    expect(await saveHabit(reading())).toEqual({ ok: false, kind: 'timeout' });
  });

  it('says it in Arabic, in the words of the design', () => {
    expect(TIMEOUT_MESSAGE).toBe('انتهت المهلة؛ يمكن المحاولة ثانية');
  });

  it('a server error is «failed», not a field error and not «offline»', async () => {
    serve({ 'POST /v1/habits': () => json({ detail: 'خطأ' }, 500) });
    expect(await saveHabit(reading())).toEqual({ ok: false, kind: 'failed' });
  });
});

describe('saveHabit: the average (feature 2)', () => {
  const average = (): HabitForm => withType({ ...reading({ target_per_period: 8000 }), title_ar: 'الخطوات' }, 'average');

  it('puts one indicator with the whole body after the habit is saved', async () => {
    serve({
      'POST /v1/habits': () => json(stored({ code: 'u_steps', kind: 'count', unit: '', target_per_period: 8000 }), 201),
      'PUT /v1/indicators/habit/u_steps': () => json({}),
    });
    const result = await saveHabit(average());
    expect(result).toMatchObject({ ok: true });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /v1/habits', 'PUT /v1/indicators/habit/u_steps']);
    expect(calls[1]?.body).toEqual({
      subject_kind: 'habit',
      subject_ref: 'u_steps',
      source: 'habit_logs',
      measure: 'avg_7d',
      target: 8000,
      period: 'day',
      display: 'number',
    });
  });

  it('keeps the saved habit when the indicator fails, and says so', async () => {
    serve({
      'POST /v1/habits': () => json(stored({ code: 'u_steps' }), 201),
      'PUT /v1/indicators/habit/u_steps': () => json({ detail: 'خطأ' }, 500),
    });
    const result = await saveHabit(average());
    expect(result).toMatchObject({ ok: true, indicator: 'failed' });
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('a plain target habit puts no indicator', async () => {
    serve({ 'POST /v1/habits': () => json(stored(), 201) });
    await saveHabit(reading());
    expect(calls.map((c) => c.method)).toEqual(['POST']);
  });
});

describe('saveHabit: an existing habit', () => {
  it('patches the changed fields alone', async () => {
    const original = stored();
    serve({ 'PATCH /v1/habits/u_1': () => json({ ...original, title_ar: 'قراءة ليلية' }) });
    const result = await saveHabit({ ...fromHabit(original), title_ar: 'قراءة ليلية' }, original);
    expect(result).toMatchObject({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'PATCH', path: '/v1/habits/u_1', body: { title_ar: 'قراءة ليلية' } });
    expect(Object.keys(calls[0]?.body as object)).toEqual(['title_ar']);
  });

  it('sends nothing when nothing changed', async () => {
    const original = stored();
    serve({});
    expect(await saveHabit(fromHabit(original), original)).toEqual({ ok: true, habit: original });
    expect(calls).toHaveLength(0);
  });

  it('the 422 for a changed polarity is «locked» with the server words on the polarity', async () => {
    const original = stored({ kind: 'boolean', unit: '', target_per_period: 1 });
    serve({
      'PATCH /v1/habits/u_1': () =>
        json(
          {
            detail: 'لا يمكن تغيير نوع العادة بعد تسجيلها',
            errors: [{ loc: ['body', 'polarity'], type: 'polarity_locked' }],
          },
          422,
        ),
    });
    const result = await saveHabit(withType(fromHabit(original), 'abstain'), original);
    expect(result).toEqual({
      ok: false,
      kind: 'locked',
      errors: { polarity: 'لا يمكن تغيير نوع العادة بعد تسجيلها' },
    });
  });

  it('the 409 of a system habit is «locked» with the server words', async () => {
    const original = stored({ system: true, created_by: 'seed' });
    serve({ 'PATCH /v1/habits/u_1': () => json({ detail: 'عادة نظامية: يُعدَّل المرسى والتذكيرات فقط' }, 409) });
    const result = await saveHabit({ ...fromHabit(original), anchor: 'after_wake' }, original);
    expect(result).toMatchObject({ ok: false, kind: 'locked' });
  });

  it('puts the indicator again on every save of an average habit, and removes it when the habit stops being one', async () => {
    const original = stored({ kind: 'count', unit: '', target_per_period: 8000 });
    serve({
      'PATCH /v1/habits/u_1': () => json({ ...original, target_per_period: 9000 }),
      'PUT /v1/indicators/habit/u_1': () => json({}),
      'DELETE /v1/indicators/habit/u_1': () => new Response(null, { status: 204 }),
    });
    const average: HabitForm = { ...fromHabit(original), measure: 'average', target_per_period: 9000 };
    await saveHabit(average, original, { hadAverage: true });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['PATCH /v1/habits/u_1', 'PUT /v1/indicators/habit/u_1']);

    calls.length = 0;
    await saveHabit({ ...fromHabit(original), measure: 'target' }, original, { hadAverage: true });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['DELETE /v1/indicators/habit/u_1']);
  });
});
