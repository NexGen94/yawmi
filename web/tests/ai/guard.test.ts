import { describe, expect, it } from 'vitest';

import { acceptDeeper, acceptInsight, NO_DATA_LINE, OUT_OF_SCOPE_LINE } from '../../src/ai/guard';
import { card, grounded, insightOut } from '../helpers/ai-fixtures';

describe('acceptInsight: the client check of a reply (design section 10)', () => {
  it('accepts a good reply as it is', () => {
    const reply = grounded();
    expect(acceptInsight(reply, 2)).toBe(reply);
  });

  it('accepts an InsightOut too, and gives back the same object type', () => {
    const reply = insightOut({ question: 'ما الذي ساعد اليوم؟' });
    expect(acceptInsight(reply, 2)?.id).toBe(reply.id);
  });

  it('rejects three lines', () => {
    expect(acceptInsight(grounded({ lines: ['أ', 'ب', 'ج'] }), 2)).toBeNull();
  });

  it('rejects a line of 201 characters and keeps one of 200', () => {
    expect(acceptInsight(grounded({ lines: ['ا'.repeat(201)] }), 2)).toBeNull();
    expect(acceptInsight(grounded({ lines: ['ا'.repeat(200)] }), 2)).not.toBeNull();
  });

  it('rejects a line that holds a new line', () => {
    expect(acceptInsight(grounded({ lines: ['سطر\nثان'] }), 2)).toBeNull();
  });

  it('rejects a question of 201 characters', () => {
    expect(acceptInsight(grounded({ question: 'س'.repeat(201) }), 2)).toBeNull();
  });

  it('rejects a source_id that is not among the cards', () => {
    expect(acceptInsight(grounded({ source_ids: ['habit:read', 'goal:O1'] }), 2)).toBeNull();
  });

  it('rejects a priority whose source is not among the cards', () => {
    const reply = grounded({ priorities: [{ title: 'مراجعة', source_id: 'goal:O9' }] });
    expect(acceptInsight(reply, 2)).toBeNull();
  });

  it('rejects two lines when ai_lines is 1', () => {
    expect(acceptInsight(grounded(), 1)).toBeNull();
    expect(acceptInsight(grounded({ lines: ['سطر واحد'] }), 1)).not.toBeNull();
  });

  it('accepts the two fixed lines (out of scope, no data) as plain replies', () => {
    for (const line of [OUT_OF_SCOPE_LINE, NO_DATA_LINE]) {
      const reply = grounded({ lines: [line], source_ids: [], cards: [], days: [], priorities: [] });
      expect(acceptInsight(reply, 1)).toBe(reply);
    }
  });

  describe('a stored row older than task 18 (M-7)', () => {
    const old = grounded({ source_ids: ['habit:read', 'goal:O1'], cards: [] });

    it('is rejected by default, and shown when the caller says its cards may be missing', () => {
      expect(acceptInsight(old, 2)).toBeNull();
      expect(acceptInsight(old, 2, { cardsOptional: true })).toBe(old);
    });

    it('still obeys the length rules', () => {
      expect(acceptInsight({ ...old, lines: ['أ', 'ب', 'ج'] }, 2, { cardsOptional: true })).toBeNull();
    });

    it('a copy saved before cards existed (no cards key at all) does not throw', () => {
      const bare = { lines: ['سطر'], question: null, source_ids: ['a'], priorities: [] } as unknown as ReturnType<typeof grounded>;
      expect(acceptInsight(bare, 2, { cardsOptional: true })).toBe(bare);
    });
  });

  it('with cards present a cited id that has its card passes', () => {
    const reply = grounded({ source_ids: ['habit:read', 'goal:O1'], cards: [card('habit:read'), card('goal:O1')] });
    expect(acceptInsight(reply, 2)).toBe(reply);
  });
});

describe('acceptDeeper', () => {
  const ok = { question: 'ما الذي يستحق التأمل؟', options: [{ title: 'ما الذي ساعد؟', source_id: 'a' }], source_ids: ['a'], refusal: null };

  it('accepts a question with up to three options', () => {
    expect(acceptDeeper(ok)).toBe(ok);
  });

  it('accepts the fixed lines: no question and a refusal', () => {
    const refused = { question: null, options: [], source_ids: [], refusal: 'no_data' as const };
    expect(acceptDeeper(refused)).toBe(refused);
  });

  it('rejects a question over 200 characters, an option title over 80, and four options', () => {
    expect(acceptDeeper({ ...ok, question: 'س'.repeat(201) })).toBeNull();
    expect(acceptDeeper({ ...ok, options: [{ title: 'س'.repeat(81), source_id: 'a' }] })).toBeNull();
    const four = Array.from({ length: 4 }, (_, i) => ({ title: `سؤال ${i}`, source_id: 'a' }));
    expect(acceptDeeper({ ...ok, options: four })).toBeNull();
  });
});
