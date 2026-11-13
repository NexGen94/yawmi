// A review that was stored is shown as it was stored. `ai_lines` is what a NEW reply may hold; a
// review made last week under two lines is not made invalid by a later choice of one line. Every
// other guard (a line's length, no new line, the question, the cards) still applies.

import type { GroundedInsight } from '../ai/guard';

/** The lines a stored reply may show: the setting now, or the lines it was stored with, up to two. */
export function storedLines(insight: Pick<GroundedInsight, 'lines'>, current: 1 | 2): 1 | 2 {
  return Math.min(2, Math.max(current, insight.lines.length)) as 1 | 2;
}
