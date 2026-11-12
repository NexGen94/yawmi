/** The limits of the server for what the day page sends (openapi.json: `MorningAnswers`,
 *  `MorningPriority`, `EveningAnswers`, `EveningPriority`, `MoodLoggedPayload`). A test compares
 *  each value with the contract, so a change on the server shows up here as a failing test. */
export const LIMITS = {
  /** A priority's title. */
  title: 120,
  enthusiasm: 200,
  /** Each gratitude line. */
  gratitude: 200,
  /** The free text of the morning and of the evening. */
  note: 2000,
  win: 300,
  learned: 300,
  /** Priorities of the morning. */
  priorities: 3,
  feelings: 6,
  activities: 12,
} as const;
