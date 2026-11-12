import type { ComponentChildren } from 'preact';

/** A link that looks like a button (`btn`). Moving to another page is a link, not a button: it opens
 *  in a new tab on request and the router handles the click. */
export function LinkButton(props: { href: string; variant?: 'primary' | 'quiet'; children: ComponentChildren }) {
  const { href, variant = 'quiet', children } = props;
  return (
    <a class={`btn btn-${variant}`} href={href}>
      {children}
    </a>
  );
}
