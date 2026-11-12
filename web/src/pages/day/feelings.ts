/** The twelve feelings of the mood grid (feature 14): nouns, never adjectives. The code goes into
 *  `mood_logged.feelings` (at most six, each at most 24 characters), the label is what is drawn. */
export const FEELINGS: readonly { code: string; label: string }[] = [
  { code: 'calm', label: 'هدوء' },
  { code: 'grateful', label: 'امتنان' },
  { code: 'excited', label: 'حماس' },
  { code: 'content', label: 'رضا' },
  { code: 'focused', label: 'تركيز' },
  { code: 'tired', label: 'تعب' },
  { code: 'anxious', label: 'قلق' },
  { code: 'tense', label: 'توتر' },
  { code: 'sad', label: 'حزن' },
  { code: 'scattered', label: 'تشتّت' },
  { code: 'frustrated', label: 'إحباط' },
  { code: 'lonely', label: 'وحدة' },
];
