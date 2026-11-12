// The four domains of the goals page and the home page (design section 13.1, ruling 7, and the
// controller's ruling m4). The whole mapping lives in this one constant: the owner may correct it
// (O12 for learning and O10 for career are both reasonable readings), and nothing else changes.
// The career headline is the text of D-049, kept in Latin letters as he wrote it.

export const DOMAINS = [
  { key: 'career', label: 'المهني', headline: 'Digital Business Transformation & Solutions Management', outcomes: ['O4', 'O5'] },
  { key: 'health', label: 'الصحي', headline: null, outcomes: ['O1'] },
  { key: 'mind', label: 'النفسي', headline: null, outcomes: ['O2'] },
  { key: 'learning', label: 'العلمي', headline: null, outcomes: ['O6', 'O7'] },
] as const;

export type Domain = (typeof DOMAINS)[number];
