/// <reference types="vite/client" />
// (for the stylesheet import below: the test tsconfig does not load vite client types itself)

import { useState } from 'preact/hooks';

import { api } from '../api/client';
import type { Day } from '../domain/types';
import { OFFLINE_NOTE } from '../lib/notes';
import { Button } from '../ui/Button';
import { ConsentNotice } from './ConsentDialog';
import { DeeperChips } from './DeeperChips';
import './insight.css';
import { acceptDeeper, type DeeperOut, OPTIONS_MAX, REFUSAL_LINES, UNAVAILABLE_TEXT } from './guard';
import { unwrapAi, useAi } from './useAi';

type State =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ok'; deeper: DeeperOut }
  | { kind: 'consent' }
  | { kind: 'offline' }
  | { kind: 'error' };

export interface DeeperBlockProps {
  day: Day;
  /** The question that shows (the one of the closing summary). */
  question: string;
}

/** «أسئلة أخرى» under the question of the closing: one go-deeper request, made when it is pressed
 *  (every request calls the provider), then up to three alternatives as chips. The fixed lines
 *  (out of scope, no data) are plain replies. */
export function DeeperBlock({ day, question }: DeeperBlockProps) {
  const ai = useAi();
  const [state, setState] = useState<State>({ kind: 'idle' });

  const load = async (): Promise<void> => {
    setState({ kind: 'loading' });
    const result = await ai.run(() => api.POST('/v1/insights/deeper', { body: { day } }).then(unwrapAi));
    if (result.kind === 'ok') {
      const accepted = acceptDeeper(result.value);
      setState(accepted === null ? { kind: 'error' } : { kind: 'ok', deeper: accepted });
    } else if (result.kind === 'consent_required') setState({ kind: 'consent' });
    else if (result.kind === 'offline') setState({ kind: 'offline' });
    else setState({ kind: 'error' });
  };

  const { dialog } = ai;
  if (state.kind === 'ok') {
    const { deeper } = state;
    if (deeper.refusal !== null) {
      return (
        <div class="ai-deeper">
          <p class="ai-question">{question}</p>
          <p class="ai-line">{REFUSAL_LINES[deeper.refusal]}</p>
          {dialog}
        </div>
      );
    }
    // The question of the server is the one shown, its alternatives are the chips under it, and the
    // question that was shown before is one more chip when there is room.
    const shown = deeper.question ?? question;
    const titles = [...deeper.options.map((o) => o.title), ...(shown === question ? [] : [question])];
    const chips = [...new Set(titles)].slice(0, OPTIONS_MAX).map((title) => ({
      title,
      source_id: deeper.options.find((o) => o.title === title)?.source_id ?? '',
    }));
    return (
      <>
        {chips.length === 0 ? (
          <div class="ai-deeper">
            <p class="ai-question">{shown}</p>
            <p class="ai-note">لا أسئلة أخرى</p>
          </div>
        ) : (
          <DeeperChips question={shown} options={chips} defaultOpen />
        )}
        {dialog}
      </>
    );
  }
  return (
    <div class="ai-deeper">
      <p class="ai-question">{question}</p>
      {state.kind === 'consent' ? (
        <ConsentNotice onEnable={() => void load()} />
      ) : (
        <>
          <Button disabled={state.kind === 'loading'} onClick={() => void load()}>
            أسئلة أخرى
          </Button>
          {state.kind === 'loading' && (
            <p class="ai-note" role="status">
              جارٍ التحليل
            </p>
          )}
          {state.kind === 'offline' && (
            <p class="ai-note" role="status">
              {OFFLINE_NOTE}
            </p>
          )}
          {state.kind === 'error' && (
            <p class="ai-note" role="alert">
              {UNAVAILABLE_TEXT}
            </p>
          )}
        </>
      )}
      {dialog}
    </div>
  );
}
