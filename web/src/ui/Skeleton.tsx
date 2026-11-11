export interface SkeletonProps {
  /** Height of the placeholder, as CSS (default: one line of body text). */
  blockSize?: string;
  /** Width of the placeholder, as CSS (default: the full line). */
  inlineSize?: string;
  /** A round placeholder, for a ring or an avatar. */
  round?: boolean;
}

/** A pale placeholder with the size of the content it stands for, so the page does not move when
 *  the content arrives. Hidden from screen readers; StateFrame announces the loading. */
export function Skeleton({ blockSize, inlineSize, round }: SkeletonProps) {
  return (
    <span
      class={round ? 'skeleton skeleton-round' : 'skeleton'}
      aria-hidden="true"
      style={{ blockSize, inlineSize }}
    />
  );
}
