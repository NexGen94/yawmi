/** One reason the server gave for refusing an event (`ValidationErrorItem`). */
export interface ErrorItem {
  loc: (string | number)[];
  type: string;
  msg?: string;
}

const FIELD: Readonly<Record<string, string>> = {
  note: 'اليومية',
  win: 'إنجاز اليوم',
  learned: 'تعلّمت',
  enthusiasm: 'سطر الحماس',
  title: 'الأولوية',
  gratitude: 'الامتنان',
  activities: 'الأنشطة',
  feelings: 'المشاعر',
  priorities: 'الأولويات',
};

const GENERIC = 'لم يقبل الخادم البيانات';

/** Why the server refused an event, in one Arabic sentence that names the field when it can. */
export function refusalReason(errors: readonly ErrorItem[]): string {
  for (const error of errors) {
    const key = [...error.loc].reverse().find((part): part is string => typeof part === 'string' && part in FIELD);
    const field = key === undefined ? undefined : FIELD[key];
    if (field === undefined) continue;
    if (error.type === 'string_too_long') return `«${field}» أطول من الحد المسموح`;
    if (error.type === 'too_long') return `«${field}» أكثر من العدد المسموح`;
  }
  return GENERIC;
}
