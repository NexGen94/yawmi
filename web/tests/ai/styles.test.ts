import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The stylesheets of the AI screens: the focus ring of the consent key (M-6) and the split of
// ai.css. The copy scan that used to open this file is tests/copy/copy.test.ts (Task 24).

const web = resolve(import.meta.dirname, '..', '..');
const src = join(web, 'src');

describe('the focus ring of the consent key (M-6)', () => {
  it('the checkbox uses the ring of the app on :focus-visible', () => {
    const css = readFileSync(join(src, 'ai/ai.css'), 'utf8');
    const rule = /\.ai-switch input:focus-visible\s*\{([^}]*)\}/.exec(css);
    expect(rule?.[1]).toContain('var(--focus)');
  });
});

describe('the stylesheet of the AI screens is split', () => {
  const read = (path: string): string => readFileSync(join(src, path), 'utf8');

  it('the home page and the first-load modules load only the small insight stylesheet', () => {
    for (const path of ['pages/home/DaySummary.tsx', 'pages/home/index.tsx', 'ai/SourceCards.tsx', 'ai/guard.ts']) {
      expect(read(path), path).not.toMatch(/ai\.css/);
    }
    expect(read('ai/SourceCards.tsx')).toMatch(/insight\.css/);
  });

  it('the consent dialog and the ask panel load the rest', () => {
    expect(read('ai/ConsentDialog.tsx')).toMatch(/ai\.css/);
    expect(read('pages/ask/AskPanel.tsx')).toMatch(/ai\.css/);
  });
});
