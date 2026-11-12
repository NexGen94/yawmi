import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { LIMITS } from '../../src/pages/day/limits';
import { refusalReason } from '../../src/pages/day/refusal';
import { sourceLabel } from '../../src/pages/day/sourceLabel';

interface Schema {
  properties: Record<string, { maxLength?: number; anyOf?: { maxLength?: number }[]; items?: { maxLength?: number }; maxItems?: number }>;
}

const openapi = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../openapi/openapi.json'), 'utf8')) as {
  components: { schemas: Record<string, Schema> };
};
const schema = (name: string): Schema => openapi.components.schemas[name] as Schema;

/** The string limit of a field, whether it is `string | null` or a plain string. */
const maxOf = (name: string, field: string): number | undefined => {
  const f = schema(name).properties[field];
  return f?.maxLength ?? f?.anyOf?.find((a) => a.maxLength !== undefined)?.maxLength;
};

describe('LIMITS follow the server contract (openapi.json)', () => {
  it('morning answers', () => {
    expect(LIMITS.title).toBe(maxOf('MorningPriority', 'title'));
    expect(LIMITS.enthusiasm).toBe(maxOf('MorningAnswers', 'enthusiasm'));
    expect(LIMITS.note).toBe(maxOf('MorningAnswers', 'note'));
    expect(LIMITS.gratitude).toBe(schema('MorningAnswers').properties.gratitude?.items?.maxLength);
    expect(LIMITS.priorities).toBe(schema('MorningAnswers').properties.priorities?.maxItems);
  });

  it('evening answers', () => {
    expect(LIMITS.win).toBe(maxOf('EveningAnswers', 'win'));
    expect(LIMITS.learned).toBe(maxOf('EveningAnswers', 'learned'));
    expect(LIMITS.note).toBe(maxOf('EveningAnswers', 'note'));
    expect(LIMITS.gratitude).toBe(schema('EveningAnswers').properties.gratitude?.items?.maxLength);
    expect(LIMITS.title).toBe(maxOf('EveningPriority', 'title'));
  });

  it('mood', () => {
    expect(LIMITS.feelings).toBe(schema('MoodLoggedPayload').properties.feelings?.maxItems);
    expect(LIMITS.activities).toBe(schema('MoodLoggedPayload').properties.activities?.maxItems);
  });
});

describe('sourceLabel', () => {
  const habits = [{ code: 'h_read', title: 'القراءة' }];
  it('names the kind in Arabic and keeps only the reference', () => {
    expect(sourceLabel('goal:O5', habits)).toEqual({ kind: 'هدف', ref: 'O5' });
    expect(sourceLabel('milestone:m12', habits)).toEqual({ kind: 'محطة', ref: 'm12' });
  });
  it('shows a habit by its title, and hides one it cannot name', () => {
    expect(sourceLabel('habit:h_read', habits)).toEqual({ kind: 'عادة', ref: 'القراءة' });
    expect(sourceLabel('habit:u_9f8e7d', habits)).toBeNull();
  });
  it('hides an unknown prefix or a bare id', () => {
    expect(sourceLabel('zzz:1', habits)).toBeNull();
    expect(sourceLabel('abc', habits)).toBeNull();
  });
});

describe('refusalReason', () => {
  const loc = (...rest: (string | number)[]) => ['body', 'events', 0, 'payload', 'answers', ...rest];
  it('names the field that is too long', () => {
    expect(refusalReason([{ loc: loc('note'), type: 'string_too_long', msg: '' }])).toContain('اليومية');
    expect(refusalReason([{ loc: loc('win'), type: 'string_too_long', msg: '' }])).toContain('إنجاز اليوم');
    expect(refusalReason([{ loc: loc('priorities', 0, 'title'), type: 'string_too_long', msg: '' }])).toContain('الأولوية');
  });
  it('says too many items for a list over its limit', () => {
    expect(refusalReason([{ loc: ['body', 'events', 0, 'payload', 'activities'], type: 'too_long', msg: '' }])).toContain('الأنشطة');
  });
  it('falls back to a plain sentence', () => {
    expect(refusalReason([])).toBe('لم يقبل الخادم البيانات');
    expect(refusalReason([{ loc: ['body'], type: 'weird', msg: '' }])).toBe('لم يقبل الخادم البيانات');
  });
});
