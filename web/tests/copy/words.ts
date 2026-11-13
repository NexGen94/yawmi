import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

// The one copy scan of the app (CLAUDE.md, design section 4): no gendered address anywhere a person
// reads. Labels are nouns («تسجيل عادة»), sentences are impersonal, and nothing praises or blames.
// This file is the one list of words. Before Task 24 four tests kept their own copies of it (AI,
// review, focus, breath), and a page that no test named (the day forms) was not scanned at all.

export const src = resolve(import.meta.dirname, '..', '..', 'src');

/** Every file of `src` the scan reads: all TypeScript and TSX but the generated API types. */
export function sourceFiles(dir: string = src): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) && !/\.d\.ts$/.test(name) ? [full] : [];
  });
}

/** The path of a source file as the tests print it: `pages/day/MorningForm.tsx`. */
export function shortName(file: string): string {
  return relative(src, file).split(sep).join('/');
}

/** The text of every string literal and every JSX text line of a source file that has Arabic in it. */
export function strings(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const out: string[] = [];
  for (const m of text.matchAll(/(['"`])((?:\.|(?!\1).)*)\1/g)) out.push(m[2] ?? '');
  for (const m of text.matchAll(/>\s*([^<>{}\n]*[؀-ۿ][^<>{}\n]*)\s*</g)) out.push(m[1] ?? '');
  for (const m of text.matchAll(/^\s*([^<>{}\n/*]*[؀-ۿ][^<>{}\n]*)$/gm)) out.push(m[1] ?? '');
  return out.filter((s) => /[؀-ۿ]/.test(s));
}

// Imperative verbs of address, masculine then feminine, that a label or a sentence must not start
// with. One group per page that asked for it, so a verb is easy to find and to add.
const IMPERATIVE_VERBS = [
  // The shared base.
  'اكتب|اكتبي|اختر|اختاري|أدخل|ادخل|أدخلي|اضغط|اضغطي|انقر|انقري|تأكد|تأكدي|تحقق|تحققي|جرّب|جرب|جربي|حاول|حاولي',
  'أعد|أعيدي|اترك|اتركي|اقرأ|اقرئي|ارجع|ارجعي|افتح|افتحي|أغلق|أغلقي|انتظر|انتظري|تابع|تابعي|اضف|أضف|أضيفي|احفظ|احفظي|احذف|احذفي',
  // The review pages: the verbs of their buttons and of the app's core action.
  'سجّل|سجل|سجّلي|سجلي|ولّد|ولدي|ولّدي|ابدأ|ابدئي|أنشئ|أنشئي|اعرض|اعرضي|راجع|راجعي|استعرض|استعرضي|شغّل|شغّلي|شغل|شغلي',
  // The focus page.
  'أنهِ|أنهي|خذ|خذي|استمر|استمري|ركّز|ركز|ركزي|حدّد|حدّدي|أوقف|أوقفي|مدّد|مدّدي|قيّم|قيّمي|فضّل|فضّلي|فعّل|فعّلي',
  // The breathing page.
  'توقف|توقفي|استرح|استريحي|تنفسي|تنفّسي|ازفر|ازفري|اشهق|اشهقي|احبس|احبسي|استنشق|استنشقي',
].join('|');

/** The imperative forms. `تنفّس` alone is also the noun's stem, so it counts only as a whole string. */
export const IMPERATIVE = new RegExp(
  String.raw`(^|[\s«(])(${IMPERATIVE_VERBS})(?=[\s»).,:؟؛،]|$)|^\s*(?:تنفّس|تنفس)(?=[\s»).,:؟؛،]|$)`,
);

// Second-person pronouns and verb endings, and the attached suffix on the nouns the app names. The
// suffix is an explicit list: a blanket «ـك» would also match ذلك and تلك.
const ADDRESS_WORDS = [
  'أنت|أنتِ|لك|لكِ|عليك|عليكِ|بإمكانك|يمكنك|يمكنكِ|تستطيع|تستطيعين|هل تريد|هل تريدين',
  '[لبو]?(?:مزاجك|يومك|يوميتك|يومياتك|أسبوعك|عاداتك|عادتك|بياناتك|أهدافك|هدفك|ملاحظاتك|مراجعتك|وقتك|أيامك|مشاعرك|جلستك|تركيزك|نفسك|نفسكِ|رسالتك|رؤيتك|خطتك|شهرك|سؤالك|أسئلتك|إجابتك|كلماتك)',
].join('|');
export const ADDRESS = new RegExp(String.raw`(^|[\s«(])(${ADDRESS_WORDS})(?=[\s»).,:؟؛،]|$)`);

/** Praise and blame: the app says what happened and nothing more. */
export const JUDGEMENT = /(^|[\s«(])(ممتاز|رائع|أحسنت|أحسنتِ|مبروك|برافو|فاشل|كسول|تقصير|مقصّر|إهمال|للأسف|لم تُكمل|لم تكمل)(?=[\s»).,:؟؛،]|$)/;

/** The breathing page alone: a mark, a rating, or a claim about health. The tests give a personal
 *  number and nothing more (design 4.1, ruling 5). */
export const CLAIM = /درجة|صحي(?!ح)|صحة|تشخيص|علاج|مرضي|طبيعي|غير طبيعي|ممتاز|ضعيف/;

/** The files `CLAIM` applies to. */
export const CLAIM_FILES = ['breath/', 'pages/breath/', 'charts/BreathBubble.tsx', 'pages/settings/TargetsSection.tsx'];

/** Strings that look like an imperative but are a noun or a past form, by file: «تحقق هدف الفترة»
 *  is «the goal of the period was met», «سجل التعديلات» is «the edit log». Each entry is tied to the
 *  file that says it, and the test fails when the file stops saying it, so the list cannot rot. */
export const NOT_IMPERATIVE: readonly { file: string; text: string }[] = [
  { file: 'habits/HabitRow.tsx', text: 'تحقق هدف الفترة' },
  { file: 'pages/habits/detail.tsx', text: 'تحقق هدف الفترة' },
  { file: 'pages/habits/PeriodMarks.tsx', text: 'تحقق' },
  { file: 'pages/goals/detail.tsx', text: 'سجل التعديلات' },
];

/** The first problem found in a string of `file` (a path from `src`), or `null`. */
export function problem(text: string, file: string): string | null {
  if (NOT_IMPERATIVE.some((n) => n.file === file && n.text === text.trim())) return null;
  if (IMPERATIVE.test(text)) return 'imperative';
  if (ADDRESS.test(text)) return 'second person';
  if (JUDGEMENT.test(text)) return 'judgement';
  return null;
}
