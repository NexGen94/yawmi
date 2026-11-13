import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The stylesheets of the breathing page. The copy scan that used to open this file (and the claim
// rule) is tests/copy/copy.test.ts (Task 24).

const web = resolve(import.meta.dirname, '..', '..');
const src = join(web, 'src');

describe('the stylesheets of the breathing page', () => {
  const css = ['pages/breath/breath.css', 'charts/bubble.css'].map((f) => [f, readFileSync(join(src, f), 'utf8')] as const);
  // The same rules as tests/styles.test.ts, which reads src/styles only.
  const physical =
    /(?:^|[\s;{])(?:left|right)\s*:|(?<![\w-])(?:margin|padding|border|inset|scroll-margin|scroll-padding)-(?:left|right)\b|(?:float|clear|text-align)\s*:\s*(?:left|right)\b/im;
  const color = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|color-mix)\(/;

  it.each(css)('%s uses logical properties and the color tokens only', (_name, text) => {
    const bare = text.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(physical.test(bare)).toBe(false);
    expect(color.test(bare)).toBe(false);
  });

  it('the bubble stops moving under prefers-reduced-motion', () => {
    const text = readFileSync(join(src, 'charts/bubble.css'), 'utf8');
    expect(text).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.bubble-core[\s\S]*transition:\s*none/);
  });
});
