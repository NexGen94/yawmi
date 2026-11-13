import { describe, expect, it } from 'vitest';

import { DOMAINS } from '../../src/goals/domains';

describe('DOMAINS', () => {
  it('names the four domains in order', () => {
    expect(DOMAINS.map((d) => d.label)).toEqual(['المهني', 'الصحي', 'النفسي', 'العلمي']);
    expect(DOMAINS.map((d) => d.key)).toEqual(['career', 'health', 'mind', 'learning']);
  });

  it('gives the career domain the headline of D-049, letter for letter', () => {
    const career = DOMAINS.find((d) => d.key === 'career');
    expect(career?.headline).toBe('Digital Business Transformation & Solutions Management');
    expect(DOMAINS.filter((d) => d.key !== 'career').every((d) => d.headline === null)).toBe(true);
  });

  it('maps outcomes as ruling 7 says', () => {
    expect(Object.fromEntries(DOMAINS.map((d) => [d.key, d.outcomes]))).toEqual({
      career: ['O4', 'O5'],
      health: ['O1'],
      mind: ['O2'],
      learning: ['O6', 'O7'],
    });
  });

  it('puts no outcome in two domains', () => {
    const all = DOMAINS.flatMap((d) => d.outcomes);
    expect(new Set(all).size).toBe(all.length);
  });
});
