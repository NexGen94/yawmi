// What every settings section does around a save: one request, the answer in words, and the same
// reason when there is no connection. Saving a setting needs the network (design 13.1, ruling 22).

import { useCallback, useState } from 'preact/hooks';

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'failed';

export const OFFLINE_NOTE = 'يحتاج اتصالاً';

export interface Saving {
  status: SaveStatus;
  busy: boolean;
  /** Runs a save; the status follows its answer. */
  run(save: () => Promise<boolean>): Promise<boolean>;
  reset(): void;
}

export function useSaving(): Saving {
  const [status, setStatus] = useState<SaveStatus>('idle');
  const run = useCallback(async (save: () => Promise<boolean>): Promise<boolean> => {
    setStatus('saving');
    const ok = await save();
    setStatus(ok ? 'saved' : 'failed');
    return ok;
  }, []);
  const reset = useCallback(() => setStatus('idle'), []);
  return { status, busy: status === 'saving', run, reset };
}

/** «تم الحفظ» or the reason a save did not happen. */
export function SaveNote({ status }: { status: SaveStatus }) {
  if (status === 'saved') {
    return (
      <p class="settings-status" role="status">
        تم الحفظ
      </p>
    );
  }
  if (status === 'failed') {
    return (
      <p class="settings-error" role="alert">
        تعذّر الحفظ؛ يمكن المحاولة ثانية
      </p>
    );
  }
  return null;
}
