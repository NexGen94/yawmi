import { useState } from 'preact/hooks';

import type { UseMemory } from '../../settings/aiData';
import { OFFLINE_NOTE } from '../../settings/saving';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { Dialog } from '../../ui/Dialog';
import { Skeleton } from '../../ui/Skeleton';
import { MemoryRow } from './MemoryRow';
import { fmt } from '../../lib/format';

export interface MemoryListProps {
  memory: UseMemory;
  online: boolean;
  /** «رسالتي» و«رؤيتي» as saved (the words are shown when they are attached). */
  mission: string;
  vision: string;
}

/** What the two personal texts do: attached with their words, or why they are not. */
function personalLine(name: string, text: string, attached: boolean): string {
  if (attached) return `${name}: تُرفق بكل طلب · «${text}»`;
  return text === '' ? `${name}: لا تُرفق، فلا نص لها بعد` : `${name}: لا تُرفق، فالنص الشخصي غير مشمول بالموافقة`;
}

/** «الذاكرة» (feature 24): everything that goes with every request, written out, with a deletion in
 *  one tap and a full reset that asks first. The saved notes are listed with their words: they are
 *  sent as data the answer may cite, never as instructions. */
export function MemoryList({ memory, online, mission, vision }: MemoryListProps) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const notes = memory.items.filter((i) => i.kind === 'note');
  const lenses = memory.items.filter((i) => i.kind === 'rule');
  const activeLenses = lenses.filter((i) => i.active).length;
  const activeNotes = notes.filter((i) => i.active).length;
  const off = !online || busy;

  const attempt = async (work: () => Promise<string | null>): Promise<boolean> => {
    setBusy(true);
    const message = await work();
    setBusy(false);
    setError(message);
    return message === null;
  };

  let body;
  if (!memory.loaded) {
    body =
      memory.state === 'loading' ? (
        <Skeleton blockSize="120px" inlineSize="100%" />
      ) : (
        <div class="state-message">
          <p class="state-text">{memory.state === 'offline' ? 'لا نسخة محفوظة بعد' : 'تعذّرت قراءة الذاكرة'}</p>
          {memory.state === 'error' && <Button onClick={memory.reload}>إعادة المحاولة</Button>}
        </div>
      );
  } else {
    body = (
      <>
        <h3 class="settings-subhead">ما يُرفق بكل طلب</h3>
        <ul class="settings-attached">
          <li>أرقام العادات والأهداف وكلمات اليومية، بعد الموافقة</li>
          <li>{`العدسات المفعّلة: ${fmt.num(activeLenses)}`}</li>
          <li>{`الملاحظات المحفوظة المفعّلة: ${fmt.num(activeNotes)}، وتُرسل بيانات لا تعليمات`}</li>
          <li>{personalLine('رسالتي', mission, memory.attached.mission)}</li>
          <li>{personalLine('رؤيتي', vision, memory.attached.vision)}</li>
        </ul>
        <h3 class="settings-subhead">الملاحظات المحفوظة</h3>
        {notes.length === 0 ? (
          <p class="settings-note">لا ملاحظات محفوظة. «حفظ في الذاكرة» تحت جواب «اسأل» يضيف واحدة.</p>
        ) : (
          <ul class="memory-list" aria-label="الملاحظات المحفوظة">
            {notes.map((item) => (
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
        <div class="settings-actions">
          <Button disabled={off || memory.items.length === 0} onClick={() => setConfirming(true)}>
            إعادة ضبط كاملة
          </Button>
          {!online && <span class="settings-hint">{OFFLINE_NOTE}</span>}
        </div>
      </>
    );
  }

  return (
    <Card title="الذاكرة" class="settings-card">
      {body}
      {error !== null && (
        <p class="settings-error" role="alert">
          {error}
        </p>
      )}
      <Dialog
        open={confirming}
        title="إعادة ضبط الذاكرة"
        onClose={() => setConfirming(false)}
        actions={
          <>
            <Button
              variant="primary"
              disabled={busy}
              onClick={() =>
                void attempt(memory.reset).then(() => {
                  setConfirming(false);
                })
              }
            >
              حذف كل البنود
            </Button>
            <Button onClick={() => setConfirming(false)}>إلغاء</Button>
          </>
        }
      >
        <p>{`يُحذف كل ما في الذاكرة: ${fmt.count(memory.items.length, 'item')} من العدسات والملاحظات. لا يمكن التراجع.`}</p>
      </Dialog>
    </Card>
  );
}
