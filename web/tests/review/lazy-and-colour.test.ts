import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The review pages are lazy and name no colour but the tokens. The copy scan that used to open this
// file is tests/copy/copy.test.ts (Task 24).

const web = resolve(import.meta.dirname, '..', '..');
const src = join(web, 'src');

describe('the review pages are lazy and use no colour of their own', () => {
  it('the router loads the review page on demand, and the first-load files do not import it', () => {
    const app = readFileSync(join(src, 'app.tsx'), 'utf8');
    expect(app).toMatch(/lazy\(\(\) => import\('\.\/pages\/review'\)\)/);
    for (const path of ['app.tsx', 'main.tsx', 'pages/home/index.tsx']) {
      expect(readFileSync(join(src, path), 'utf8'), path).not.toMatch(/from '\.{1,2}\/(pages\/)?review/);
    }
  });

  it('the stylesheets name no colour but the tokens', () => {
    for (const path of ['pages/review/review.css', 'charts/year-grid.css']) {
      const css = readFileSync(join(src, path), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      expect(css, path).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|color-mix)\(/);
    }
  });
});
