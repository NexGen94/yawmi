// A counted noun with the word that agrees with it («محطة واحدة مستحقة»، «محطتان مستحقتان»،
// «4 محطات مستحقة»). The noun and its number come from `fmt.count`, so the rules of 3 to 10, 11 to 99
// and 100 and over are written once. Every noun here is feminine, as the words it is used with are.

import { fmt, type Noun } from './format';

/** `n` of `noun` followed by the word that agrees with it: `singular` after one and after three or
 *  more (the plural of a thing is feminine singular), `dual` after two. For a word that does not
 *  change («بلا موعد»), pass it twice. Zero is for the caller to say in its own words. */
export function counted(n: number, noun: Noun, singular: string, dual: string): string {
  if (n === 1) return `${fmt.count(1, noun)} واحدة ${singular}`;
  if (n === 2) return `${fmt.count(2, noun)} ${dual}`;
  return `${fmt.count(n, noun)} ${singular}`;
}

/** «لا أولويات مفتوحة»، «أولوية واحدة مفتوحة»، «أولويتان مفتوحتان»، «3 أولويات مفتوحة». */
export function openCountText(n: number): string {
  if (n === 0) return 'لا أولويات مفتوحة';
  return counted(n, 'priority', 'مفتوحة', 'مفتوحتان');
}
