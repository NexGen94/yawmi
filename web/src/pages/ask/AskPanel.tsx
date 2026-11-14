/// <reference types="vite/client" />
// (for the stylesheet import below: the test tsconfig does not load vite client types itself)

import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

import { acceptInsight, type GroundedInsight, UNAVAILABLE_TEXT } from '../../ai/guard';
import { ConsentNotice } from '../../ai/ConsentDialog';
import { InsightCard } from '../../ai/InsightCard';
import { callAi, unwrapAi, useAi, type AiResult } from '../../ai/useAi';
import '../../ai/ai.css';
import { api } from '../../api/client';
import { OFFLINE_NOTE } from '../../lib/notes';
import { useSettings } from '../../settings/data';
import { Button } from '../../ui/Button';
import { Field } from '../../ui/Field';
import { Skeleton } from '../../ui/Skeleton';
import { type AskRange, RangeChips } from './RangeChips';

/** The three questions offered before any is written (design 4). */
export const READY_QUESTIONS = ['ما حالة أهدافي هذا الأسبوع؟', 'أين التقدّم وأين التأخر؟', 'ما علاقة مزاجي بعاداتي؟'] as const;

/** What the server takes as a question (`AskRequest.question`). */
const QUESTION_MAX = 500;
/** What a saved note holds (`MemoryIn.text`). */
const NOTE_MAX = 300;

type Phase =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ok'; insight: GroundedInsight }
  | { kind: 'consent' }
  | { kind: 'offline' }
  | { kind: 'error'; message: string };

type NoteStatus = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved' } | { kind: 'failed'; message: string };

/** The lines of the answer as one note of at most 300 characters: whole lines only. */
function noteText(insight: GroundedInsight): string {
  let text = '';
  for (const line of insight.lines) {
    const next = text === '' ? line : `${text} ${line}`;
    if (next.length > NOTE_MAX) break;
    text = next;
  }
  return text;
}

/** The panel of «اسأل» (design 4): the question, the range, three ready questions, and the answer in
 *  two lines with the cards of its sources. The browser sends the question and the range, and the
 *  server builds the sources. Used by the side panel and by the /ask page. */
export interface AskPanelProps {
  /** In the side panel the question button is in the pinned actions of the drawer, not in the form:
   *  the drawer gives a ref this panel fills with «ask now», and hears when a question is out. */
  pinned?: { submitRef: { current: (() => void) | null }; onBusy(busy: boolean): void };
}

export function AskPanel({ pinned }: AskPanelProps = {}) {
  const settings = useSettings();
  const maxLines = settings.data?.ai_lines ?? 2;
  const ai = useAi();
  const [question, setQuestion] = useState('');
  const [range, setRange] = useState<AskRange>('7d');
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [note, setNote] = useState<NoteStatus>({ kind: 'idle' });
  // The look at the answer uses the lines the person asked for when it arrives, not when it was asked.
  const linesNow = useRef(maxLines);
  linesNow.current = maxLines;
  const turn = useRef(0);
  const lastAsked = useRef('');

  const settle = (result: AiResult<GroundedInsight>): Phase => {
    switch (result.kind) {
      case 'ok': {
        const accepted = acceptInsight(result.value, linesNow.current);
        return accepted === null ? { kind: 'error', message: UNAVAILABLE_TEXT } : { kind: 'ok', insight: accepted };
      }
      case 'consent_required':
        return { kind: 'consent' };
      case 'offline':
        return { kind: 'offline' };
      default:
        return { kind: 'error', message: result.message };
    }
  };

  const send = useCallback(
    async (text: string, over?: AskRange): Promise<void> => {
      const asked = text.trim();
      if (asked === '') return;
      lastAsked.current = asked;
      const mine = ++turn.current;
      setPhase({ kind: 'loading' });
      setNote({ kind: 'idle' });
      const result = await ai.run(() =>
        api.POST('/v1/ask', { body: { question: asked, range: over ?? range } }).then(unwrapAi),
      );
      if (mine === turn.current) setPhase(settle(result));
    },
    [ai.run, range],
  );

  const saveNote = async (insight: GroundedInsight): Promise<void> => {
    const text = noteText(insight);
    if (text === '') return;
    setNote({ kind: 'saving' });
    const result = await callAi(() => api.POST('/v1/ai/memory', { body: { kind: 'note', text } }).then(unwrapAi));
    if (result.kind === 'ok') setNote({ kind: 'saved' });
    else if (result.kind === 'offline') setNote({ kind: 'failed', message: OFFLINE_NOTE });
    else setNote({ kind: 'failed', message: 'message' in result ? result.message : 'تعذّر الحفظ؛ يمكن المحاولة ثانية' });
  };

  const busy = phase.kind === 'loading';
  if (pinned) pinned.submitRef.current = () => void send(question);
  const tellBusy = pinned?.onBusy;
  useEffect(() => {
    tellBusy?.(busy);
  }, [busy, tellBusy]);
  let body;
  switch (phase.kind) {
    case 'idle':
      body = (
        <div class="state-message">
          <p class="state-text">يمكن كتابة سؤال أو اختيار واحد من الأسئلة الجاهزة</p>
        </div>
      );
      break;
    case 'loading':
      body = (
        <>
          <span class="state-text" role="status">
            جارٍ التحليل
          </span>
          <Skeleton blockSize="var(--fs-num)" inlineSize="40%" />
          <Skeleton inlineSize="90%" />
          <Skeleton inlineSize="70%" />
        </>
      );
      break;
    case 'ok':
      body = (
        <div class="ask-answer">
          <InsightCard insight={phase.insight} maxLines={maxLines} />
          <div class="ask-actions">
            <Button disabled={note.kind === 'saving' || note.kind === 'saved'} onClick={() => void saveNote(phase.insight)}>
              حفظ في الذاكرة
            </Button>
            {note.kind === 'saved' && (
              <p class="ask-status" role="status">
                حُفظ في الذاكرة
              </p>
            )}
            {note.kind === 'failed' && (
              <p class="ask-status ask-status-error" role="alert">
                {note.message}
              </p>
            )}
          </div>
        </div>
      );
      break;
    case 'consent':
      body = <ConsentNotice onEnable={() => void send(lastAsked.current || question)} />;
      break;
    case 'offline':
      body = (
        <div class="state-message">
          <p class="state-text">{OFFLINE_NOTE}</p>
          <Button onClick={() => void send(lastAsked.current)}>إعادة المحاولة</Button>
        </div>
      );
      break;
    case 'error':
      body = (
        <div class="state-message" role="alert">
          <p class="state-text">{phase.message}</p>
          <Button onClick={() => void send(lastAsked.current)}>إعادة المحاولة</Button>
        </div>
      );
      break;
  }

  return (
    <div class="ask-panel">
      <form
        class="ask-form"
        onSubmit={(event) => {
          event.preventDefault();
          void send(question);
        }}
      >
        <Field label="السؤال" value={question} maxLength={QUESTION_MAX} onInput={setQuestion} />
        <RangeChips value={range} onChange={setRange} disabled={busy} />
        {!pinned && (
          <div class="ask-actions">
            <Button type="submit" variant="primary" disabled={busy}>
              سؤال
            </Button>
          </div>
        )}
      </form>
      <fieldset class="ask-ready" aria-label="أسئلة جاهزة">
        {READY_QUESTIONS.map((q) => (
          <button
            key={q}
            type="button"
            class="chip"
            disabled={busy}
            onClick={() => {
              setQuestion(q);
              void send(q);
            }}
          >
            {q}
          </button>
        ))}
      </fieldset>
      <div class="state-frame" aria-busy={busy ? 'true' : 'false'}>
        {body}
      </div>
      {ai.dialog}
    </div>
  );
}
