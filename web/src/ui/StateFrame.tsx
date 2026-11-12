import type { ComponentChildren } from 'preact';

import { Badge } from './Badge';
import { Button } from './Button';
import { Skeleton } from './Skeleton';

export interface StateFrameProps {
  /** loading, ready, error, or offline (no connection). */
  state: 'loading' | 'ready' | 'error' | 'offline';
  /** The data loaded but holds nothing: show `emptyText` and `emptyAction` instead of children. */
  empty?: boolean;
  /** One sentence that says what is missing («لا عادات بعد.»). */
  emptyText: string;
  /** The action that fills the page («عادة جديدة»). */
  emptyAction?: ComponentChildren;
  /** With `offline`: the children are the last saved copy, shown with a badge. Without it,
   *  offline means there is no copy yet. */
  stale?: boolean;
  onRetry(): void;
  children: ComponentChildren;
  /** Placeholders with the size of the page's content (default: three lines). */
  skeleton?: ComponentChildren;
}

const TEXT = {
  loading: 'جارٍ التحميل',
  error: 'تعذّر التحميل',
  retry: 'إعادة المحاولة',
  stale: 'نسخة محفوظة · بلا اتصال',
  noCopy: 'لا نسخة محفوظة بعد',
};

function DefaultSkeleton() {
  return (
    <>
      <Skeleton blockSize="var(--fs-num)" inlineSize="40%" />
      <Skeleton inlineSize="90%" />
      <Skeleton inlineSize="70%" />
    </>
  );
}

/** The four states every page draws (design section 4). The outer element stays the same in
 *  every state, so moving from loading to ready changes only what is inside it. */
export function StateFrame(props: StateFrameProps) {
  const { state, empty, emptyText, emptyAction, stale, onRetry, children, skeleton } = props;

  const emptyBlock = (
    <div class="state-message">
      <p class="state-text">{emptyText}</p>
      {emptyAction}
    </div>
  );

  let body: ComponentChildren;
  switch (state) {
    case 'loading':
      body = (
        <>
          <span class="visually-hidden" role="status">
            {TEXT.loading}
          </span>
          {skeleton ?? <DefaultSkeleton />}
        </>
      );
      break;
    case 'error':
      body = (
        <div class="state-message" role="alert">
          <p class="state-text">{TEXT.error}</p>
          <Button onClick={onRetry}>{TEXT.retry}</Button>
        </div>
      );
      break;
    case 'offline':
      body = stale ? (
        <>
          <div class="state-stale">
            <Badge>{TEXT.stale}</Badge>
          </div>
          {empty ? emptyBlock : children}
        </>
      ) : (
        <div class="state-message">
          <p class="state-text">{TEXT.noCopy}</p>
        </div>
      );
      break;
    case 'ready':
      body = empty ? emptyBlock : children;
      break;
  }

  return (
    <div class="state-frame" aria-busy={state === 'loading' ? 'true' : 'false'}>
      {body}
    </div>
  );
}
