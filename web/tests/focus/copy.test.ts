import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The copy scan of the focus page (and the two home cards it touches): no gendered address, in
// labels (nouns, never imperatives) and in sentences (impersonal). The same rules as
// tests/ai/copy-and-styles.test.ts, for these files.

const src = resolve(import.meta.dirname, '..', '..', 'src');

const FILES = [
  'focus',
  'pages/focus',
  'charts/Plant.tsx',
  'charts/HourBars.tsx',
  'pages/home/QuickAccess.tsx',
  'pages/home/DaySummary.tsx',
];

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
  /(^|[\s«(])(اكتب|اكتبي|اختر|اختاري|أدخل|ادخل|أدخلي|اضغط|اضغطي|انقر|انقري|تأكد|تأكدي|تحقق|تحققي|جرّب|جرب|جربي|حاول|حاولي|أعد|أعيدي|اترك|اتركي|اقرأ|اقرئي|ارجع|ارجعي|افتح|افتحي|أغلق|أغلقي|انتظر|انتظري|تابع|تابعي|اضف|أضف|أضيفي|احفظ|احفظي|احذف|احذفي|ابدأ|ابدئي|أنهِ|أنهي|خذ|خذي|استمر|استمري|ركّز|ركز|ركزي|سجّل|سجّلي|حدّد|حدّدي|أوقف|أوقفي|مدّد|مدّدي|قيّم|قيّمي|فضّل|فضّلي|شغّل|شغّلي|فعّل|فعّلي)(?=[\s»).,:؟؛،]|$)/;
// Second-person pronouns and verb endings.
const ADDRESS =
  /(^|[\s«(])(أنت|أنتِ|لك|لكِ|عليك|عليكِ|بإمكانك|يمكنك|يمكنكِ|تستطيع|تستطيعين|هل تريد|هل تريدين|وقتك|جلستك|تركيزك)(?=[\s»).,:؟؛،]|$)/;
// Blame and praise: the focus page says what happened and nothing more.
const JUDGEMENT = /(فشل|لم تُكمل|لم تكمل|تقصير|مقصّر|خسارة|أحسنت|رائع|ممتاز|برافو|مبروك|للأسف)/;

describe('the strings of the focus page', () => {
  const all = FILES.flatMap(files).filter((f) => /\.(ts|tsx)$/.test(f));

  it('scans a non-trivial set of files and strings', () => {
    expect(all.length).toBeGreaterThan(12);
    expect(all.flatMap(strings).length).toBeGreaterThan(80);
  });

  it('the scan catches an imperative, an address and a judgement (so a pass means something)', () => {
    expect(IMPERATIVE.test('ابدأ الجلسة')).toBe(true);
    expect(IMPERATIVE.test('بدء')).toBe(false);
    expect(ADDRESS.test('يمكنك التمديد')).toBe(true);
    expect(JUDGEMENT.test('أحسنت')).toBe(true);
  });

  it.each(['سجّل عادة', 'حدّد هدفاً يومياً', 'أوقف الخطة', 'مدّد الجلسة', 'قيّم التركيز', 'فضّل الخطة', 'شغّل المؤقت', 'سجّلي عادة'])(
    'the scan catches a verb the page uses in «%s»',
    (text) => {
      expect(IMPERATIVE.test(text)).toBe(true);
    },
  );

  it('and leaves the nouns and the past forms of the page alone', () => {
    for (const ok of ['تسجيل عادة', 'سُجّلت الدقائق في عادة', 'تحديد هدف', 'إيقاف', 'تمديد', 'تقييم التركيز', 'تفضيل', 'تفعيل']) {
      expect(IMPERATIVE.test(ok), ok).toBe(false);
    }
  });

  it.each(all.map((f) => [f.slice(src.length + 1).replaceAll('\\', '/'), f] as const))(
    '%s has no gendered address and no judgement',
    (_name, file) => {
      const bad = strings(file).filter((s) => IMPERATIVE.test(s) || ADDRESS.test(s) || JUDGEMENT.test(s));
      expect(bad).toEqual([]);
    },
  );
});
