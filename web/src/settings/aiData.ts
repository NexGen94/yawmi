// The AI settings of the person: the consent (`/v1/ai/consent`) and the visible memory
// (`/v1/ai/memory`). Reading keeps a saved copy like every page; every change is a settings call:
// it needs the network and is never queued (design 13.1, ruling 22).

import { useCallback, useEffect, useState } from 'preact/hooks';

import { api } from '../api/client';
import type { components } from '../api/schema';
import { unwrap } from '../api/unwrap';
import { aiError, callAi, unwrapAi } from '../ai/useAi';
import { useQuery } from '../data/query';
import { OFFLINE_NOTE } from '../lib/notes';

export type ConsentOut = components['schemas']['ConsentOut'];
export type MemoryItem = components['schemas']['MemoryItem'];
export type MemoryList = components['schemas']['MemoryList'];

const FAILED = 'تعذّر الحفظ؛ يمكن المحاولة ثانية';

/** Why a change of the memory did not happen: the words of the server when it gave some. */
function reason(result: { kind: string; message?: string }): string {
  if (result.kind === 'offline') return OFFLINE_NOTE;
  return result.message ?? FAILED;
}

export interface UseConsent {
  data: ConsentOut | undefined;
  state: 'loading' | 'ready' | 'error' | 'offline';
  reload(): void;
  /** PUT the consent for the current provider; the message of a refusal, or null when it stands. */
  grant(personalText: boolean): Promise<string | null>;
  /** DELETE: the consent is withdrawn (the row stays on the server). */
  withdraw(): Promise<string | null>;
}

export function useConsent(): UseConsent {
  const query = useQuery<ConsentOut>('ai/consent', () => api.GET('/v1/ai/consent').then(unwrap));
  const [saved, setSaved] = useState<ConsentOut | undefined>(undefined);
  useEffect(() => setSaved(undefined), [query.data]);
  const data = saved ?? query.data;

  const grant = useCallback(
    async (personalText: boolean): Promise<string | null> => {
      if (data === undefined) return FAILED;
      const result = await callAi(() =>
        api.PUT('/v1/ai/consent', { body: { provider: data.provider, personal_text: personalText } }).then(unwrapAi),
      );
      if (result.kind !== 'ok') return reason(result);
      setSaved(result.value);
      return null;
    },
    [data],
  );

  const withdraw = useCallback(async (): Promise<string | null> => {
    const result = await callAi(() => api.DELETE('/v1/ai/consent').then(unwrapAi));
    if (result.kind !== 'ok') return reason(result);
    setSaved(result.value);
    return null;
  }, []);

  return { data, state: query.state, reload: query.reload, grant, withdraw };
}

export interface UseMemory {
  items: MemoryItem[];
  /** Whether «رسالتي» and «رؤيتي» go with every request. */
  attached: { mission: boolean; vision: boolean };
  state: 'loading' | 'ready' | 'error' | 'offline';
  stale: boolean;
  loaded: boolean;
  reload(): void;
  /** Each returns the message of a refusal, or null when the server took it. */
  add(kind: 'rule' | 'note', text: string): Promise<string | null>;
  setActive(item: MemoryItem, active: boolean): Promise<string | null>;
  remove(item: MemoryItem): Promise<string | null>;
  reset(): Promise<string | null>;
}

export function useMemory(): UseMemory {
  const query = useQuery<MemoryList>('ai/memory', () => api.GET('/v1/ai/memory').then(unwrap));
  const [list, setList] = useState<MemoryList | undefined>(undefined);
  // A newer reading replaces what the changes made over the old one.
  useEffect(() => setList(query.data), [query.data]);

  const add = useCallback(async (kind: 'rule' | 'note', text: string): Promise<string | null> => {
    const result = await callAi(() => api.POST('/v1/ai/memory', { body: { kind, text } }).then(unwrapAi));
    if (result.kind !== 'ok') return reason(result);
    setList((l) => (l === undefined ? l : { ...l, items: [...l.items, result.value] }));
    return null;
  }, []);

  const setActive = useCallback(async (item: MemoryItem, active: boolean): Promise<string | null> => {
    const result = await callAi(() =>
      api.PATCH('/v1/ai/memory/{memory_id}', { params: { path: { memory_id: item.id } }, body: { active } }).then(unwrapAi),
    );
    if (result.kind !== 'ok') return reason(result);
    setList((l) => (l === undefined ? l : { ...l, items: l.items.map((i) => (i.id === item.id ? result.value : i)) }));
    return null;
  }, []);

  const remove = useCallback(async (item: MemoryItem): Promise<string | null> => {
    const result = await callAi(async () => {
      const r = await api.DELETE('/v1/ai/memory/{memory_id}', { params: { path: { memory_id: item.id } } });
      if (!r.response.ok) throw aiError(r);
    });
    if (result.kind !== 'ok') return reason(result);
    setList((l) => (l === undefined ? l : { ...l, items: l.items.filter((i) => i.id !== item.id) }));
    return null;
  }, []);

  const reset = useCallback(async (): Promise<string | null> => {
    const result = await callAi(async () => {
      const r = await api.DELETE('/v1/ai/memory');
      if (!r.response.ok) throw aiError(r);
    });
    if (result.kind !== 'ok') return reason(result);
    setList((l) => (l === undefined ? l : { ...l, items: [] }));
    return null;
  }, []);

  return {
    items: list?.items ?? [],
    attached: list?.attached ?? { mission: false, vision: false },
    state: query.state,
    stale: query.stale,
    loaded: list !== undefined,
    reload: query.reload,
    add,
    setActive,
    remove,
    reset,
  };
}
