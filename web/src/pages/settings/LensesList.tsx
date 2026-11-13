import { useState } from 'preact/hooks';

import type { MemoryItem, UseMemory } from '../../settings/aiData';
import { OFFLINE_NOTE } from '../../settings/saving';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { Field } from '../../ui/Field';
import { Skeleton } from '../../ui/Skeleton';
import { MemoryRow } from './MemoryRow';

/** The longest text of an item (`MemoryIn.text`). */
export const MEMORY_TEXT_MAX = 300;

export interface LensesListProps {
  memory: UseMemory;
  online: boolean;
}

/** «العدسات» (feature 23): standing rules that the person writes and that go with every request,
 *  each switchable and deletable. A lens that asks for a diagnosis or a therapy does not widen the
 *  limits: while it is on, every reply is the out-of-scope line, and one line says so. */
export function LensesList({ memory, online }: LensesListProps) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lenses = memory.items.filter((i) => i.kind === 'rule');
  const off = !online || busy;

  const attempt = async (work: () => Promise<string | null>): Promise<boolean> => {
    setBusy(true);
    const message = await work();
    setBusy(false);
    setError(message);
    return message === null;
  };

  return (
    <Card title="العدسات" class="settings-card">
      <p class="settings-note">العدسة قاعدة دائمة لقراءة البيانات، وتُرفق بكل طلب ما دامت مفعّلة.</p>
      <p class="settings-note">عدسة تطلب تشخيصاً أو علاجاً تجعل كل رد «خارج النطاق» ما دامت مفعّلة.</p>
      {!memory.loaded ? (
        memory.state === 'loading' ? (
          <Skeleton blockSize="60px" inlineSize="100%" />
        ) : (
          <p class="settings-note">{memory.state === 'offline' ? OFFLINE_NOTE : 'تعذّرت قراءة العدسات'}</p>
        )
      ) : lenses.length === 0 ? (
        <p class="settings-note">لا عدسات بعد</p>
      ) : (
        <ul class="memory-list" aria-label="العدسات">
          {lenses.map((item: MemoryItem) => (
            <MemoryRow
              key={item.id}
              item={item}
              disabled={off}
              onToggle={(it, active) => void attempt(() => memory.setActive(it, active))}
              onRemove={(it) => void attempt(() => memory.remove(it))}
            />
          ))}
        </ul>
      )}
      <Field label="عدسة جديدة" value={text} maxLength={MEMORY_TEXT_MAX} disabled={off} onInput={setText} />
      <div class="settings-actions">
        <Button
          variant="primary"
          disabled={off || text.trim() === ''}
          onClick={() =>
            void attempt(() => memory.add('rule', text.trim())).then((ok) => {
              if (ok) setText('');
            })
          }
        >
          إضافة عدسة
        </Button>
        {!online && <span class="settings-hint">{OFFLINE_NOTE}</span>}
      </div>
      {error !== null && (
        <p class="settings-error" role="alert">
          {error}
        </p>
      )}
    </Card>
  );
}
