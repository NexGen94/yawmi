/// <reference types="vite/client" />
// (for the stylesheet import below: the test tsconfig does not load vite client types itself)

import { useState } from 'preact/hooks';

import type { components } from '../api/schema';
import { OPTIONS_MAX } from './guard';
import './insight.css';

type Priority = components['schemas']['Priority'];

export interface DeeperChipsProps {
  /** The one question that shows. */
  question: string;
  /** Up to three alternative questions, shown on «أسئلة أخرى». */
  options: readonly Priority[];
  /** The chips show at once (the person already pressed «أسئلة أخرى» elsewhere). */
  defaultOpen?: boolean;
}

/** «Go deeper» (feature 20): one question, and behind a button up to three others as chips. A chip
 *  becomes the question that shows, and the one it replaces goes into the chips. */
export function DeeperChips({ question, options, defaultOpen = false }: DeeperChipsProps) {
  const [shown, setShown] = useState(question);
  const [others, setOthers] = useState<string[]>(() => options.slice(0, OPTIONS_MAX).map((o) => o.title));
  const [open, setOpen] = useState(defaultOpen);

  const choose = (index: number): void => {
    const picked = others[index];
    if (picked === undefined) return;
    setOthers(others.map((q, i) => (i === index ? shown : q)));
    setShown(picked);
  };

  return (
    <div class="ai-deeper">
      <p class="ai-question" aria-live="polite">
        {shown}
      </p>
      {others.length > 0 && (
        <>
          <button type="button" class="btn btn-quiet" aria-expanded={open ? 'true' : 'false'} onClick={() => setOpen(!open)}>
            أسئلة أخرى
          </button>
          {open && (
            <fieldset class="chips" aria-label="أسئلة أخرى">
              {others.map((q, i) => (
                <button key={`${i}-${q}`} type="button" class="chip" onClick={() => choose(i)}>
                  {q}
                </button>
              ))}
            </fieldset>
          )}
        </>
      )}
    </div>
  );
}
