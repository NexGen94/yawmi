import type { ComponentChildren } from 'preact';

const ISO_DAY = /(\d{4}-\d{2}-\d{2})/;

/** Text in which every ISO day (2031-12-31) is its own left-to-right run, so that the digits and
 *  dashes keep their order inside Arabic text and never break across a line. The text itself is
 *  unchanged. */
export function Iso({ text }: { text: string }) {
  const parts = text.split(ISO_DAY);
  const nodes: ComponentChildren[] = [parts[0]];
  // split() with one capture group alternates text, day, text, day, ...
  for (let at = 1; at < parts.length; at += 2) {
    nodes.push(
      <bdi dir="ltr" class="nowrap">
        {parts[at]}
      </bdi>,
      parts[at + 1],
    );
  }
  return <>{nodes}</>;
}
