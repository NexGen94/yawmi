// @vitest-environment happy-dom
import 'fake-indexeddb/auto';

import { fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { api } from '../../src/api/client';
import { ConsentNotice } from '../../src/ai/ConsentDialog';
import { callAi, PROVIDER_LABELS, unwrapAi, useAi, type AiResult } from '../../src/ai/useAi';
import { consent, consentRequired, grounded, json, stubServer } from '../helpers/ai-fixtures';

afterEach(() => {
  vi.unstubAllGlobals();
});

const ask = () => api.POST('/v1/ask', { body: { question: 'ما حالتي؟', range: '7d' } }).then(unwrapAi);

function Harness(props: { onResult(r: AiResult<unknown>): void; prompt?: boolean }) {
  const ai = useAi();
  return (
    <>
      <button type="button" onClick={() => void ai.run(ask, { prompt: props.prompt }).then(props.onResult)}>
        تشغيل
      </button>
      {ai.dialog}
    </>
  );
}

/** The ask route answers 403 until a consent was put, then a reply. */
function server(over: { provider?: 'anthropic' | 'deepseek' } = {}) {
  let granted = false;
  return stubServer({
    'GET /v1/ai/consent': () => json(consent({ provider: over.provider ?? 'anthropic' })),
    'PUT /v1/ai/consent': (call) => {
      granted = true;
      const body = call.body as { provider: string; personal_text: boolean };
      return json(consent({ provider: body.provider as 'anthropic', granted: true, personal_text: body.personal_text }));
    },
    'POST /v1/ask': () => (granted ? json(grounded()) : consentRequired()),
  });
}

describe('PROVIDER_LABELS', () => {
  it('names the two providers', () => {
    expect(PROVIDER_LABELS).toEqual({ anthropic: 'Anthropic', deepseek: 'DeepSeek' });
  });
});

describe('callAi: what a call becomes', () => {
  it('ok: the value', async () => {
    expect(await callAi(async () => 5)).toEqual({ kind: 'ok', value: 5 });
  });

  it('403 ai_consent_required: consent_required', async () => {
    stubServer({ 'POST /v1/ask': () => consentRequired() });
    expect(await callAi(ask)).toEqual({ kind: 'consent_required' });
  });

  it('a 403 with another code is not a missing consent', async () => {
    stubServer({ 'POST /v1/ask': () => json({ detail: 'غير مسموح' }, 403) });
    expect((await callAi(ask)).kind).toBe('unavailable');
  });

  it('a failed network: offline', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    expect(await callAi(ask)).toEqual({ kind: 'offline' });
  });

  it('503 and 502: unavailable, with the words of the server', async () => {
    stubServer({ 'POST /v1/ask': () => json({ detail: 'الخدمة الذكية غير مفعّلة', errors: [{ loc: ['body'], type: 'ai_not_configured' }] }, 503) });
    expect(await callAi(ask)).toEqual({ kind: 'unavailable', message: 'الخدمة الذكية غير مفعّلة' });
  });

  it('422: refused, with the words of the server', async () => {
    stubServer({ 'POST /v1/ask': () => json({ detail: 'تعذّر الرد على هذا الطلب', errors: [{ loc: ['body'], type: 'ai_refusal' }] }, 422) });
    expect(await callAi(ask)).toEqual({ kind: 'refused', message: 'تعذّر الرد على هذا الطلب' });
  });
});

describe('the consent dialog', () => {
  it('names the provider, counts what is sent and keeps the personal-text key off', async () => {
    server();
    render(<Harness onResult={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'تشغيل' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findAllByText(/Anthropic/);
    expect(dialog.textContent).toContain('Anthropic');
    expect(within(within(dialog).getByRole('list', { name: 'ما يُرسل' })).getAllByRole('listitem')).toHaveLength(4);
    const personal = within(dialog).getByRole('checkbox', { name: /رسالتي/ }) as HTMLInputElement;
    expect(personal.checked).toBe(false);
  });

  it('names DeepSeek when that is the current provider', async () => {
    server({ provider: 'deepseek' });
    render(<Harness onResult={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'تشغيل' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findAllByText(/DeepSeek/);
  });

  it('«موافقة» puts the consent once, then repeats the original call once', async () => {
    const s = server();
    const onResult = vi.fn();
    render(<Harness onResult={onResult} />);
    fireEvent.click(screen.getByRole('button', { name: 'تشغيل' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findAllByText(/Anthropic/);
    expect(s.of('POST', '/v1/ask')).toHaveLength(1);
    fireEvent.click(within(dialog).getByRole('button', { name: 'موافقة' }));
    await waitFor(() => expect(onResult).toHaveBeenCalledTimes(1));
    expect(s.of('PUT', '/v1/ai/consent')).toHaveLength(1);
    expect(s.of('PUT', '/v1/ai/consent')[0]?.body).toEqual({ provider: 'anthropic', personal_text: false });
    expect(s.of('POST', '/v1/ask')).toHaveLength(2);
    expect(onResult.mock.calls[0]?.[0]).toMatchObject({ kind: 'ok' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('the personal-text key, once turned on, goes with the consent', async () => {
    const s = server();
    render(<Harness onResult={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'تشغيل' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findAllByText(/Anthropic/);
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /رسالتي/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'موافقة' }));
    await waitFor(() => expect(s.of('PUT', '/v1/ai/consent')).toHaveLength(1));
    expect(s.of('PUT', '/v1/ai/consent')[0]?.body).toEqual({ provider: 'anthropic', personal_text: true });
  });

  it('«ليس الآن» calls nothing and the caller is told the consent is missing', async () => {
    const s = server();
    const onResult = vi.fn();
    render(<Harness onResult={onResult} />);
    fireEvent.click(screen.getByRole('button', { name: 'تشغيل' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findAllByText(/Anthropic/);
    const before = s.calls.length;
    fireEvent.click(within(dialog).getByRole('button', { name: 'ليس الآن' }));
    await waitFor(() => expect(onResult).toHaveBeenCalledTimes(1));
    expect(onResult.mock.calls[0]?.[0]).toEqual({ kind: 'consent_required' });
    expect(s.calls.length).toBe(before);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('with prompt: false no dialog opens and nothing else is called', async () => {
    const s = server();
    const onResult = vi.fn();
    render(<Harness onResult={onResult} prompt={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'تشغيل' }));
    await waitFor(() => expect(onResult).toHaveBeenCalledTimes(1));
    expect(onResult.mock.calls[0]?.[0]).toEqual({ kind: 'consent_required' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(s.of('GET', '/v1/ai/consent')).toHaveLength(0);
  });
});

describe('ConsentNotice', () => {
  it('says the AI is stopped until the consent, with a button that asks for it', () => {
    const onEnable = vi.fn();
    render(<ConsentNotice onEnable={onEnable} />);
    expect(screen.getByText('الذكاء الاصطناعي متوقف حتى الموافقة')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'تفعيل الذكاء الاصطناعي' }));
    expect(onEnable).toHaveBeenCalledTimes(1);
  });
});
