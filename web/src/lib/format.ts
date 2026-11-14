// Arabic number, date and counted-noun formatting. Every screen goes through `fmt`, so the
// digits setting (latn by default, arab on request) applies in one place. The Hijri date is
// display only; the app's days are always Gregorian ISO days (YYYY-MM-DD, Asia/Riyadh).

export type Digits = 'latn' | 'arab';

/** Nouns that `fmt.count` knows. The whole table lives here so no later task edits this file. */
export type Noun = 'day' | 'minute' | 'hour' | 'second' | 'session' | 'time' | 'milestone' | 'item' | 'habit' | 'cycle' | 'priority';

interface Forms {
  /** Exactly one: the noun alone, without a numeral. */
  one: string;
  /** Exactly two: the dual, without a numeral. */
  two: string;
  /** 0, and 3 to 10 (also when the last two digits are 3 to 10, as in 103): the plural. */
  few: string;
  /** 11 to 99 (and the same last two digits above 100), and fractions: the accusative singular. */
  many: string;
  /** 100, 101, 102, 200, 1000, 1001, 1002...: the genitive singular, written without tanween. */
  gen: string;
}

const NOUNS: Record<Exclude<Noun, 'second'>, Forms> = {
  day: { one: 'يوم', two: 'يومان', few: 'أيام', many: 'يوماً', gen: 'يوم' },
  minute: { one: 'دقيقة', two: 'دقيقتان', few: 'دقائق', many: 'دقيقة', gen: 'دقيقة' },
  hour: { one: 'ساعة', two: 'ساعتان', few: 'ساعات', many: 'ساعة', gen: 'ساعة' },
  session: { one: 'جلسة', two: 'جلستان', few: 'جلسات', many: 'جلسة', gen: 'جلسة' },
  time: { one: 'مرة', two: 'مرتان', few: 'مرات', many: 'مرة', gen: 'مرة' },
  milestone: { one: 'محطة', two: 'محطتان', few: 'محطات', many: 'محطة', gen: 'محطة' },
  habit: { one: 'عادة', two: 'عادتان', few: 'عادات', many: 'عادة', gen: 'عادة' },
  cycle: { one: 'دورة', two: 'دورتان', few: 'دورات', many: 'دورة', gen: 'دورة' },
  priority: { one: 'أولوية', two: 'أولويتان', few: 'أولويات', many: 'أولوية', gen: 'أولوية' },
  item: { one: 'بند واحد', two: 'بندان', few: 'بنود', many: 'بنداً', gen: 'بند' },
};

// Seconds are always written short, with the numeral: "42 ث".
const SECOND_ABBREVIATION = 'ث';

let digits: Digits = 'latn';

/** Chooses Latin (0 to 9) or Arabic-Indic digits for every later `fmt` call. */
export function setDigits(d: Digits): void {
  digits = d;
}

/** The digits now in force. */
export function getDigits(): Digits {
  return digits;
}

const numberFormats = new Map<string, Intl.NumberFormat>();
const dateFormats = new Map<string, Intl.DateTimeFormat>();

function numberFormat(options?: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${digits}|${JSON.stringify(options ?? {})}`;
  let format = numberFormats.get(key);
  if (!format) {
    format = new Intl.NumberFormat(`ar-SA-u-nu-${digits}`, options);
    numberFormats.set(key, format);
  }
  return format;
}

// ar-SA defaults to the Umm al-Qura calendar, so the Gregorian one is always named explicitly.
function dateFormat(calendar: 'gregory' | 'islamic-umalqura', options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${digits}|${calendar}|${JSON.stringify(options)}`;
  let format = dateFormats.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat(`ar-SA-u-ca-${calendar}-nu-${digits}`, { ...options, timeZone: 'UTC' });
    dateFormats.set(key, format);
  }
  return format;
}

const MISSING = '—';
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

// The day is read from the text alone and formatted in UTC, so the zone of the browser can never
// move it to the neighbouring day.
function isoDayToDate(iso: string): Date | undefined {
  const match = ISO_DAY.exec(iso);
  if (!match) return undefined;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  // Date.UTC rolls 2026-02-30 over to March: accept the day only if it reads back unchanged.
  const same = date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  return same ? date : undefined;
}

function noun(n: number, word: Noun): string {
  if (word === 'second') return `${num(n)} ${SECOND_ABBREVIATION}`;
  const forms = NOUNS[word];
  if (n === 1) return forms.one;
  if (n === 2) return forms.two;
  const integer = Number.isInteger(n);
  const abs = Math.abs(n);
  const last2 = integer ? abs % 100 : -1;
  if (n === 0 || (last2 >= 3 && last2 <= 10)) return `${num(n)} ${forms.few}`;
  if (integer && abs >= 100 && last2 <= 2) return `${num(n)} ${forms.gen}`;
  return `${num(n)} ${forms.many}`;
}

function num(n: number, options?: Intl.NumberFormatOptions): string {
  return numberFormat(options).format(n);
}

export const fmt = {
  /** A number in the current digits, grouped; `options` goes straight to `Intl.NumberFormat`. */
  num,

  /** `text` isolated as left-to-right inside a right-to-left sentence. After Arabic words a number
   *  takes the Arabic-number class and its percent sign lands on the wrong side («%50»); inside the
   *  isolate it reads «50%». Use it for a percentage that follows words (Task 24). */
  ltr(text: string): string {
    return `\u2066${text}\u2069`;
  },

  /** A ratio (0.5) as a whole percentage ("50%"). A missing or infinite ratio gives a dash. */
  pct(x: number): string {
    if (!Number.isFinite(x)) return MISSING;
    return `${num(Math.round(x * 100))}${digits === 'arab' ? '٪' : '%'}`;
  },

  /** An ISO day as a Gregorian date with its weekday: "الثلاثاء، 10 نوفمبر 2026". */
  day(iso: string): string {
    const date = isoDayToDate(iso);
    if (!date) return MISSING;
    return dateFormat('gregory', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(date);
  },

  /** An ISO day as a short Gregorian date, without the weekday and the year: "9 نوفمبر". */
  dayShort(iso: string): string {
    const date = isoDayToDate(iso);
    if (!date) return MISSING;
    return dateFormat('gregory', { day: 'numeric', month: 'long' }).format(date);
  },

  /** An ISO day as an Umm al-Qura date, display only: "16 رمضان 1453 هـ". */
  hijri(iso: string): string {
    const date = isoDayToDate(iso);
    if (!date) return MISSING;
    return dateFormat('islamic-umalqura', { day: 'numeric', month: 'long', year: 'numeric' }).format(date);
  },

  /** A figure with its unit, for a number slot (a card, a fact): 1 and 2 keep their numeral
   *  («1 يوم», «2 أيام»), where `count` says «يوم» and «يومان» in a sentence. */
  stat(n: number, word: Noun): string {
    if (word === 'second' || (n !== 1 && n !== 2)) return noun(n, word);
    return `${num(n)} ${n === 1 ? NOUNS[word].one : NOUNS[word].few}`;
  },

  /** A count with its noun: "يوم"، "يومان"، "3 أيام"، "11 يوماً". */
  count(n: number, word: Noun): string {
    return noun(n, word);
  },
};
