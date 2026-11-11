// Arabic number, date and counted-noun formatting. Every screen goes through `fmt`, so the
// digits setting (latn by default, arab on request) applies in one place. The Hijri date is
// display only; the app's days are always Gregorian ISO days (YYYY-MM-DD, Asia/Riyadh).

export type Digits = 'latn' | 'arab';

/** Nouns that `fmt.count` knows. The whole table lives here so no later task edits this file. */
export type Noun = 'day' | 'minute' | 'hour' | 'second' | 'session' | 'time' | 'milestone' | 'item';

interface Forms {
  /** Exactly one: the noun alone, without a numeral. */
  one: string;
  /** Exactly two: the dual, without a numeral. */
  two: string;
  /** 0, and 3 to 10 (also when the last two digits are 3 to 10, as in 103): the plural. */
  few: string;
  /** 11 and more, and fractions: the accusative singular after the numeral. */
  many: string;
}

const NOUNS: Record<Exclude<Noun, 'second'>, Forms> = {
  day: { one: 'يوم', two: 'يومان', few: 'أيام', many: 'يوماً' },
  minute: { one: 'دقيقة', two: 'دقيقتان', few: 'دقائق', many: 'دقيقة' },
  hour: { one: 'ساعة', two: 'ساعتان', few: 'ساعات', many: 'ساعة' },
  session: { one: 'جلسة', two: 'جلستان', few: 'جلسات', many: 'جلسة' },
  time: { one: 'مرة', two: 'مرتان', few: 'مرات', many: 'مرة' },
  milestone: { one: 'محطة', two: 'محطتان', few: 'محطات', many: 'محطة' },
  item: { one: 'بند واحد', two: 'بندان', few: 'بنود', many: 'بنداً' },
};

// Seconds are always written short, with the numeral: "42 ث".
const SECOND_ABBREVIATION = 'ث';

let digits: Digits = 'latn';

/** Chooses Latin (0 to 9) or Arabic-Indic digits for every later `fmt` call. */
export function setDigits(d: Digits): void {
  digits = d;
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
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function noun(n: number, word: Noun): string {
  if (word === 'second') return `${num(n)} ${SECOND_ABBREVIATION}`;
  const forms = NOUNS[word];
  if (n === 1) return forms.one;
  if (n === 2) return forms.two;
  const last2 = Number.isInteger(n) ? Math.abs(n) % 100 : -1;
  const plural = n === 0 || (last2 >= 3 && last2 <= 10);
  return `${num(n)} ${plural ? forms.few : forms.many}`;
}

function num(n: number, options?: Intl.NumberFormatOptions): string {
  return numberFormat(options).format(n);
}

export const fmt = {
  /** A number in the current digits, grouped; `options` goes straight to `Intl.NumberFormat`. */
  num,

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

  /** An ISO day as an Umm al-Qura date, display only: "16 رمضان 1453 هـ". */
  hijri(iso: string): string {
    const date = isoDayToDate(iso);
    if (!date) return MISSING;
    return dateFormat('islamic-umalqura', { day: 'numeric', month: 'long', year: 'numeric' }).format(date);
  },

  /** A count with its noun: "يوم"، "يومان"، "3 أيام"، "11 يوماً". */
  count(n: number, word: Noun): string {
    return noun(n, word);
  },
};
