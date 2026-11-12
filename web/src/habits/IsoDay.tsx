/** An ISO day (`2026-11-15`) inside Arabic text. After Arabic letters the digits take the order of
 *  Arabic numbers and the hyphens split them, so the day would read `15-11-2026`: it is isolated and
 *  set left to right. */
export function IsoDay({ day }: { day: string }) {
  return <bdi dir="ltr">{day}</bdi>;
}
