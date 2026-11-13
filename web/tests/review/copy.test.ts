import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// I-3 for the review pages: no gendered address in what they say (CLAUDE.md, design section 4):
// labels are nouns and sentences are impersonal. The same scan as `tests/ai/copy-and-styles.test.ts`,
// over the files of task 21. The two pages that hold the personal text say it in numbers and nouns.

const web = resolve(import.meta.dirname, '..', '..');
const src = join(web, 'src');

const FILES = ['pages/review', 'review', 'charts/YearGrid.tsx'];

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
  /(^|[\s«(])(اكتب|اكتبي|اختر|اختاري|أدخل|ادخل|أدخلي|اضغط|اضغطي|انقر|انقري|تأكد|تأكدي|تحقق|تحققي|جرّب|جرب|جربي|حاول|حاولي|أعد|أعيدي|اترك|اتركي|اقرأ|اقرئي|ارجع|ارجعي|افتح|افتحي|أغلق|أغلقي|انتظر|انتظري|تابع|تابعي|اضف|أضف|أضيفي|احفظ|احفظي|احذف|احذفي)(?=[\s»).,:؟؛،]|$)/;
// Second-person pronouns and verb endings.
const ADDRESS = /(^|[\s«(])(أنت|أنتِ|لك|لكِ|عليك|عليكِ|بإمكانك|يمكنك|يمكنكِ|تستطيع|تستطيعين|هل تريد|هل تريدين)(?=[\s»).,:؟؛،]|$)/;
// No praise or blame (CLAUDE.md): a word that judges the week.
const JUDGING = /(^|[\s«(])(ممتاز|رائع|أحسنت|أحسنتِ|مبروك|فاشل|كسول|تقصير|إهمال|للأسف)(?=[\s»).,:؟؛،]|$)/;

describe('the strings of the review pages', () => {
  const all = FILES.flatMap(files).filter((f) => /\.(ts|tsx)$/.test(f));

  it('scans a non-trivial set of files and strings', () => {
    expect(all.length).toBeGreaterThan(10);
    expect(all.flatMap(strings).length).toBeGreaterThan(40);
  });

  it('the scan catches an imperative and a judgement (so a pass means something)', () => {
    expect(IMPERATIVE.test('اكتب ملاحظة')).toBe(true);
    expect(ADDRESS.test('يمكنك الكتابة')).toBe(true);
    expect(JUDGING.test('أسبوع ممتاز')).toBe(true);
    expect(IMPERATIVE.test('يمكن عرض المزيد')).toBe(false);
  });

  it.each(all.map((f) => [f.slice(src.length + 1).replaceAll('\\', '/'), f] as const))(
    '%s has no gendered address and no judgement',
    (_name, file) => {
      const bad = strings(file).filter((s) => IMPERATIVE.test(s) || ADDRESS.test(s) || JUDGING.test(s));
      expect(bad).toEqual([]);
    },
  );
});

describe('the review pages are lazy and use no colour of their own', () => {
  it('the router loads the review page on demand, and the first-load files do not import it', () => {
    const app = readFileSync(join(src, 'app.tsx'), 'utf8');
    expect(app).toMatch(/lazy\(\(\) => import\('\.\/pages\/review'\)\)/);
    for (const path of ['app.tsx', 'main.tsx', 'pages/home/index.tsx']) {
      expect(readFileSync(join(src, path), 'utf8'), path).not.toMatch(/from '\.{1,2}\/(pages\/)?review/);
    }
  });

  it('the stylesheets name no colour but the tokens', () => {
    for (const path of ['pages/review/review.css', 'charts/year-grid.css']) {
      const css = readFileSync(join(src, path), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      expect(css, path).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|color-mix)\(/);
    }
  });
});
