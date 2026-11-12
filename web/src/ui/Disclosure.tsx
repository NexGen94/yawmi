import type { ComponentChildren } from 'preact';

export interface DisclosureProps {
  /** The always-visible line that opens the details. */
  summary: ComponentChildren;
  children: ComponentChildren;
  defaultOpen?: boolean;
}

/** Details on demand, on the native details element: Enter and Space toggle it, and it is found by
 *  find-in-page. The chevron turns, which reads the same in both directions. */
export function Disclosure({ summary, children, defaultOpen }: DisclosureProps) {
  return (
    <details class="disclosure" open={defaultOpen}>
      <summary class="disclosure-summary">
        <span>{summary}</span>
        <svg class="disclosure-chevron" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
          <path d="M5 7.5l5 5 5-5" fill="none" stroke="currentColor" />
        </svg>
      </summary>
      <div class="disclosure-body">{children}</div>
    </details>
  );
}
