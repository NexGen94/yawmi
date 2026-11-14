import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ADDRESS, CLAIM, CLAIM_FILES, IMPERATIVE, JUDGEMENT, NOT_IMPERATIVE, problem, shortName, sourceFiles, src, strings } from './words';

// The one copy scan of the app (CLAIM in words.ts is the breathing page's alone). It replaces the
// four scans that lived in tests/ai, tests/review, tests/focus and tests/breath, each over its own
// list of files: this one reads every file under src/, so a page nobody named (the morning and
// evening forms were one) is scanned too (Task 20 N-1, Task 21 I-2).

const all = sourceFiles();
const named = all.map((f) => [shortName(f), f] as const);

describe('the copy scan reads the whole app', () => {
  it('reads every source file under src, and a non-trivial number of strings', () => {
    expect(all.length).toBeGreaterThan(200);
    expect(all.flatMap(strings).length).toBeGreaterThan(1500);
  });

  it('reads every page directory, and the files of the day forms among them', () => {
    const scanned = new Set(named.map(([name]) => name));
    for (const dir of readdirSync(join(src, 'pages')).filter((d) => statSync(join(src, 'pages', d)).isDirectory())) {
      expect([...scanned].some((n) => n.startsWith(`pages/${dir}/`)), `pages/${dir}`).toBe(true);
    }
    for (const must of ['pages/day/MorningForm.tsx', 'pages/day/EveningForm.tsx', 'pages/day/ClosureCard.tsx', 'shell/Sidebar.tsx', 'ui/Dialog.tsx', 'app.tsx']) {
      expect(scanned.has(must), must).toBe(true);
    }
  });

  it('has Arabic strings in the two day forms (a scan of nothing would pass)', () => {
    for (const form of ['pages/day/MorningForm.tsx', 'pages/day/EveningForm.tsx']) {
      expect(strings(join(src, form)).length, form).toBeGreaterThan(5);
    }
  });
});

describe('the scan catches what it is for (so a pass means something)', () => {
  it('an imperative, in the masculine and the feminine, whatever the page', () => {
    for (const planted of [
      'اكتب سؤالاً أو اختر واحداً',
      'سجّل مزاجك اليوم',
      'سجل مزاجك اليوم',
      'ولّد مراجعة الأسبوع',
      'ابدأ يومية الصباح',
      'أنشئ عادة',
      'اعرض المزيد',
      'راجع الأسبوع',
      'اكتب ملاحظة',
      'اختر عادة',
      'سجّلي المزاج',
      'ولّدي المراجعة',
      'ابدئي اليوم',
      'استعرض السجل',
      'شغّل التنبيه',
      'ابدأ الجلسة',
      'سجّل عادة',
      'حدّد هدفاً يومياً',
      'أوقف الخطة',
      'مدّد الجلسة',
      'قيّم التركيز',
      'فضّل الخطة',
      'سجّلي عادة',
      'احبس نفسك',
      'ازفر ببطء',
      'تنفّس بعمق',
      'تنفسي ببطء',
      'اشهق ثم ازفر',
      'خذي نفساً',
      'استنشق الهواء',
      'أوقفي التمرين',
      'استمر في الزفير',
      'احفظ اليومية',
      'أغلق اليوم',
    ]) {
      expect(IMPERATIVE.test(planted), planted).toBe(true);
    }
  });

  it('a second-person form, with a pronoun or a suffix', () => {
    for (const planted of [
      'يمكنك الكتابة',
      'يمكنك التمديد',
      'يمكنكِ التوقف',
      'مزاجك اليوم',
      'كيف كان يومك',
      'أسبوعك',
      'عاداتك',
      'بياناتك',
      'أنت',
      'مراجعة لأسبوعك',
      'احبس نفسك',
      'نفسك',
      'هل تريد المتابعة',
    ]) {
      expect(ADDRESS.test(planted) || IMPERATIVE.test(planted), planted).toBe(true);
    }
  });

  it('praise and blame', () => {
    for (const planted of ['أسبوع ممتاز', 'أحسنت', 'رائع', 'مبروك', 'للأسف', 'لم تكمل الجلسة', 'برافو']) {
      expect(JUDGEMENT.test(planted), planted).toBe(true);
    }
  });

  it('a claim about health, on the breathing page', () => {
    expect(CLAIM.test('درجة صحية')).toBe(true);
    expect(CLAIM.test('عدد صحيح')).toBe(false);
  });

  it('spares the nouns, the labels and the impersonal sentences of the app', () => {
    for (const fine of [
      'يمكن عرض المزيد',
      'يمكن التوقف في أي لحظة',
      'السجل',
      'تسجيل المزاج',
      'بدء يومية الصباح',
      'توليد مراجعة الأسبوع',
      'إعادة التوليد',
      'عرض المزيد',
      'مراجعة الأسبوع',
      'ملخص الأشهر',
      'ذلك',
      'تلك',
      'للوعي الذاتي',
      'تسجيل عادة',
      'سُجّلت الدقائق في عادة',
      'تحديد هدف',
      'إيقاف',
      'تمديد',
      'تقييم التركيز',
      'تفضيل',
      'تفعيل',
      'بدء الحبس',
      'اختبار حبس النفس',
      'جلسة تنفّس',
      'يتوقف القياس وحده عند 60 ث',
      'انتهاء الزفير',
      'حبس النفس',
      'بدء',
    ]) {
      expect(IMPERATIVE.test(fine) || ADDRESS.test(fine) || JUDGEMENT.test(fine), fine).toBe(false);
    }
  });

  it('flags a planted imperative and a planted second person in any file, by name', () => {
    expect(problem('اكتب ملاحظة', 'pages/day/MorningForm.tsx')).toBe('imperative');
    expect(problem('يمكنك التعديل', 'pages/day/EveningForm.tsx')).toBe('second person');
    expect(problem('أسبوع ممتاز', 'pages/review/index.tsx')).toBe('judgement');
    expect(problem('تسجيل عادة', 'pages/day/MorningForm.tsx')).toBeNull();
  });
});

describe('the exceptions are real', () => {
  it.each(NOT_IMPERATIVE.map((n) => [`${n.file}: ${n.text}`, n] as const))('%s is still said by its file (and only that file is spared)', (_label, n) => {
    expect(strings(join(src, n.file)).map((s) => s.trim())).toContain(n.text);
    expect(problem(n.text, n.file)).toBeNull();
    expect(problem(n.text, 'pages/day/MorningForm.tsx')).not.toBeNull();
  });
});

describe('the strings of every file', () => {
  it.each(named)('%s has no gendered address and no judgement', (name, file) => {
    const bad = strings(file).filter((s) => problem(s, name) !== null);
    expect(bad).toEqual([]);
  });

  it.each(named.filter(([name]) => CLAIM_FILES.some((c) => name === c || name.startsWith(c))))(
    '%s never calls a result a mark or a health statement',
    (_name, file) => {
      const bad = strings(file).filter((s) => CLAIM.test(s));
      expect(bad).toEqual([]);
    },
  );

  it('the breathing files the claim rule reads are all there', () => {
    const claimed = named.filter(([name]) => CLAIM_FILES.some((c) => name === c || name.startsWith(c)));
    expect(claimed.length).toBeGreaterThan(12);
    expect(readFileSync(claimed[0]![1], 'utf8').length).toBeGreaterThan(0);
  });
});
