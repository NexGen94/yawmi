import type { ComponentChildren } from 'preact';

export interface BadgeProps {
  /** neutral: an outcome code or a state (pale ground, ink text). signal: what needs attention
   *  (signal ground and ink, plus a dot); the text always says what it is. */
  tone?: 'neutral' | 'signal';
  children: ComponentChildren;
}

export function Badge({ tone = 'neutral', children }: BadgeProps) {
  return (
    <span class={tone === 'signal' ? 'badge badge-signal' : 'badge'}>
      {tone === 'signal' && <span class="badge-dot" aria-hidden="true" />}
      {children}
    </span>
  );
}
