import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The copy scan of the AI screens (tests/ai/copy-and-styles.test.ts), for the breathing page: no
// gendered address, labels that are nouns, and no word that turns a personal number into a mark or a
// statement about health (design 4.1, ruling 5). A sibling of that test, so that file stays as it is.

const web = resolve(import.meta.dirname, '..', '..');
const src = join(web, 'src');

const FILES = ['breath', 'pages/breath', 'charts/BreathBubble.tsx', 'pages/settings/TargetsSection.tsx'];

function files(path: string): string[] {
  const full = join(src, path);
  if (!statSync(full).isDirectory()) return [full];
  return readdirSync(full).flatMap((name) => files(join(path, name)));
}

/** The text of every string literal and every JSX text line of a source file. */
function strings(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const out: string[] = [];
  for (const m of text.matchAll(/(['"`])((?:\\.|(?!\1).)*)\1/g)) out.push(m[2] ?? '');
  for (const m of text.matchAll(/>\s*([^<>{}\n]*[؀-ۿ][^<>{}\n]*)\s*</g)) out.push(m[1] ?? '');
  for (const m of text.matchAll(/^\s*([^<>{}\n/*]*[؀-ۿ][^<>{}\n]*)$/gm)) out.push(m[1] ?? '');
  return out.filter((s) => /[؀-ۿ]/.test(s));
}

// Imperative verbs of address (masculine or feminine) that a label or sentence must not start with.
const IMPERATIVE =
  /(^|[\s«(])(اكتب|اكتبي|اختر|اختاري|أدخل|ادخل|أدخلي|اضغط|اضغطي|انقر|انقري|تأكد|تأكدي|تحقق|تحققي|جرّب|جرب|جربي|حاول|حاولي|أعد|أعيدي|اترك|اتركي|اقرأ|اقرئي|ارجع|ارجعي|افتح|افتحي|أغلق|أغلقي|انتظر|انتظري|تابع|تابعي|اضف|أضف|أضيفي|احفظ|احفظي|احذف|احذفي|توقف|توقفي|ابدأ|ابدئي|استرح|استريحي|تنفسي|تنفّسي|ازفر|ازفري|اشهق|اشهقي|احبس|احبسي|خذ|خذي|استنشق|استنشقي|أوقف|أوقفي|استمر|استمري)(?=[\s»).,:؟؛،]|$)|^\s*(?:تنفّس|تنفس)(?=[\s»).,:؟؛،]|$)/;
// Second-person pronouns and verb endings.
const ADDRESS = /(^|[\s«(])(أنت|أنتِ|لك|لكِ|عليك|عليكِ|بإمكانك|يمكنك|يمكنكِ|تستطيع|تستطيعين|هل تريد|هل تريدين|نفسك|نفسكِ)(?=[\s»).,:؟؛،]|$)/;
// A mark, a rating, or a claim about health: the tests give a personal number, nothing more.
const CLAIM = /درجة|صحي(?!ح)|صحة|تشخيص|علاج|مرضي|طبيعي|غير طبيعي|ممتاز|ضعيف/;

describe('the strings of the breathing page', () => {
  const all = FILES.flatMap(files).filter((f) => /\.(ts|tsx)$/.test(f));

  it('scans a non-trivial set of files and strings', () => {
    expect(all.length).toBeGreaterThan(12);
    expect(all.flatMap(strings).length).toBeGreaterThan(40);
  });

  it('the scan catches what it is for (so a pass means something)', () => {
    expect(IMPERATIVE.test("ابدأ الآن")).toBe(true);
    // The verbs a breathing page is most likely to use, in both forms.
    for (const text of ['احبس نفسك', 'ازفر ببطء', 'تنفّس بعمق', 'تنفسي ببطء', 'اشهق ثم ازفر', 'خذي نفساً', 'استنشق الهواء', 'أوقفي التمرين', 'استمر في الزفير']) {
      expect(IMPERATIVE.test(text) || ADDRESS.test(text), text).toBe(true);
    }
    expect(ADDRESS.test('احبس نفسك')).toBe(true);
    expect(ADDRESS.test('حبس النفس')).toBe(false);
    // Nouns and impersonal sentences that look alike stay clean.
    for (const text of ['بدء الحبس', 'اختبار حبس النفس', 'جلسة تنفّس', 'يتوقف القياس وحده عند 60 ث', 'يمكن التوقف في أي لحظة', 'انتهاء الزفير']) {
      expect(IMPERATIVE.test(text) || ADDRESS.test(text), text).toBe(false);
    }
    expect(IMPERATIVE.test('بدء')).toBe(false);
    expect(ADDRESS.test('يمكنك التوقف')).toBe(true);
    expect(ADDRESS.test('يمكن التوقف في أي لحظة')).toBe(false);
    expect(CLAIM.test('درجة صحية')).toBe(true);
    expect(CLAIM.test('عدد صحيح')).toBe(false);
  });

  it.each(all.map((f) => [f.slice(src.length + 1).replaceAll('\\', '/'), f] as const))('%s has no gendered address', (_name, file) => {
    const bad = strings(file).filter((s) => IMPERATIVE.test(s) || ADDRESS.test(s));
    expect(bad).toEqual([]);
  });

  it.each(all.map((f) => [f.slice(src.length + 1).replaceAll('\\', '/'), f] as const))('%s never calls a result a mark or a health statement', (_name, file) => {
    const bad = strings(file).filter((s) => CLAIM.test(s));
    expect(bad).toEqual([]);
  });
});

describe('the stylesheets of the breathing page', () => {
  const css = ['pages/breath/breath.css', 'charts/bubble.css'].map((f) => [f, readFileSync(join(src, f), 'utf8')] as const);
  // The same rules as tests/styles.test.ts, which reads src/styles only.
  const physical =
    /(?:^|[\s;{])(?:left|right)\s*:|(?<![\w-])(?:margin|padding|border|inset|scroll-margin|scroll-padding)-(?:left|right)\b|(?:float|clear|text-align)\s*:\s*(?:left|right)\b/im;
  const color = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|color-mix)\(/;

  it.each(css)('%s uses logical properties and the color tokens only', (_name, text) => {
    const bare = text.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(physical.test(bare)).toBe(false);
    expect(color.test(bare)).toBe(false);
  });

  it('the bubble stops moving under prefers-reduced-motion', () => {
    const text = readFileSync(join(src, 'charts/bubble.css'), 'utf8');
    expect(text).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.bubble-core[\s\S]*transition:\s*none/);
  });
});
