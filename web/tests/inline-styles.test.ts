import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { shortName, sourceFiles } from './copy/words';

// The design (5.1) allows colour only through the tokens, logical properties only, and the red of
// the drawings (--c-signal) never for text. The stylesheets are scanned by tests/styles.test.ts;
// this reads the style={{ ... }} of the components, where the sections written in Task 6 (pairing,
// notifications, session) kept physical margins, a token that does not exist (--c-muted) and
// the drawing red for text.

const tsx = sourceFiles().filter((f) => f.endsWith('.tsx'));
const styleObjects = (file: string): string[] =>
  [...readFileSync(file, 'utf8').matchAll(/style=\{\{([\s\S]*?)\}\}/g)].map((m) => m[1] ?? '');

const PHYSICAL = /\b(?:margin|padding|border)(?:Top|Bottom|Left|Right)\b|\b(?:left|right|top|bottom)\s*:|\btextAlign\s*:\s*['"](?:left|right)['"]/;
const TOKEN = /var\((--[\w-]+)\)/g;
const KNOWN = new Set(
  [...readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8').matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]),
);

describe('the inline styles of the components', () => {
  it('are found by the scan (a pass means something)', () => {
    expect(tsx.flatMap(styleObjects).length).toBeGreaterThan(2);
    expect(PHYSICAL.test("marginTop: '1rem'")).toBe(true);
    expect(PHYSICAL.test("marginBlockStart: '1rem'")).toBe(false);
  });

  it.each(tsx.map((f) => [shortName(f), f] as const))('%s: no physical property, no unknown token, no drawing red for text', (_name, file) => {
    const found: string[] = [];
    for (const style of styleObjects(file)) {
      if (PHYSICAL.test(style)) found.push(`physical: ${style.trim().slice(0, 60)}`);
      for (const m of style.matchAll(TOKEN)) {
        const name = m[1] as string;
        // custom properties set by the component itself (--lane-y) are not tokens
        if (!KNOWN.has(name) && !style.includes(`'${name}':`)) found.push(`unknown token ${name}`);
      }
      if (/color\s*:\s*['"]var\(--c-signal\)['"]/.test(style)) found.push('--c-signal as a text colour');
    }
    expect(found).toEqual([]);
  });
});
