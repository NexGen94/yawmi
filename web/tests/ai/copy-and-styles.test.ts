import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// I-3: no gendered address in what the AI screens say (CLAUDE.md, design section 4): labels are
// nouns and sentences are impersonal. The scan reads the string literals of the files this task
// wrote for the AI screens. M-6 and the CSS split are pinned here too.

const web = resolve(import.meta.dirname, '..', '..');
const src = join(web, 'src');

const FILES = [
  'ai',
  'pages/ask',
  'pages/settings/AiSection.tsx',
  'pages/settings/AiStyleSection.tsx',
  'pages/settings/LensesList.tsx',
  'pages/settings/MemoryList.tsx',
  'pages/settings/MemoryRow.tsx',
  'pages/day/ClosureAi.tsx',
  'settings/aiData.ts',
  'shell/AskDrawer.tsx',
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
  /(^|[\s«(])(اكتب|اكتبي|اختر|اختاري|أدخل|ادخل|أدخلي|اضغط|اضغطي|انقر|انقري|تأكد|تأكدي|تحقق|تحققي|جرّب|جرب|جربي|حاول|حاولي|أعد|أعيدي|اترك|اتركي|اقرأ|اقرئي|ارجع|ارجعي|افتح|افتحي|أغلق|أغلقي|انتظر|انتظري|تابع|تابعي|اضف|أضف|أضيفي|احفظ|احفظي|احذف|احذفي)(?=[\s»).,:؟؛،]|$)/;
// Second-person pronouns and verb endings.
const ADDRESS = /(^|[\s«(])(أنت|أنتِ|لك|لكِ|عليك|عليكِ|بإمكانك|يمكنك|يمكنكِ|تستطيع|تستطيعين|هل تريد|هل تريدين)(?=[\s»).,:؟؛،]|$)/;

describe('the strings of the AI screens', () => {
  const all = FILES.flatMap(files).filter((f) => /\.(ts|tsx)$/.test(f));

  it('scans a non-trivial set of files and strings', () => {
    expect(all.length).toBeGreaterThan(15);
    expect(all.flatMap(strings).length).toBeGreaterThan(60);
  });

  it('the scan catches an imperative (so a pass means something)', () => {
    expect(IMPERATIVE.test('اكتب سؤالاً أو اختر واحداً')).toBe(true);
    expect(IMPERATIVE.test('يمكن كتابة سؤال أو اختيار واحد')).toBe(false);
    expect(ADDRESS.test('يمكنك الكتابة')).toBe(true);
  });

  it.each(all.map((f) => [f.slice(src.length + 1).replaceAll('\\', '/'), f] as const))('%s has no gendered address', (_name, file) => {
    const bad = strings(file).filter((s) => IMPERATIVE.test(s) || ADDRESS.test(s));
    expect(bad).toEqual([]);
  });
});

describe('the focus ring of the consent key (M-6)', () => {
  it('the checkbox uses the ring of the app on :focus-visible', () => {
    const css = readFileSync(join(src, 'ai/ai.css'), 'utf8');
    const rule = /\.ai-switch input:focus-visible\s*\{([^}]*)\}/.exec(css);
    expect(rule?.[1]).toContain('var(--focus)');
  });
});

describe('the stylesheet of the AI screens is split', () => {
  const read = (path: string): string => readFileSync(join(src, path), 'utf8');

  it('the home page and the first-load modules load only the small insight stylesheet', () => {
    for (const path of ['pages/home/DaySummary.tsx', 'pages/home/index.tsx', 'ai/SourceCards.tsx', 'ai/guard.ts']) {
      expect(read(path), path).not.toMatch(/ai\.css/);
    }
    expect(read('ai/SourceCards.tsx')).toMatch(/insight\.css/);
  });

  it('the consent dialog and the ask panel load the rest', () => {
    expect(read('ai/ConsentDialog.tsx')).toMatch(/ai\.css/);
    expect(read('pages/ask/AskPanel.tsx')).toMatch(/ai\.css/);
  });
});
