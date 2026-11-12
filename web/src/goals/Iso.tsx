const ISO_DAY = /(\d{4}-\d{2}-\d{2})/;

/** Text in which every ISO day (2031-12-31) is its own left-to-right run, so that the digits and
 *  dashes keep their order inside Arabic text and never break across a line. The text itself is
 *  unchanged. */
export function Iso({ text }: { text: string }) {
  return (
    <>
      {text.split(ISO_DAY).map((part, i) =>
        i % 2 === 1 ? (
          <bdi key={i} dir="ltr" class="nowrap">
            {part}
          </bdi>
        ) : (
          part
        ),
      )}
    </>
  );
}
