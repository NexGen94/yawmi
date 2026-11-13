import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// WCAG 1.4.11: a mark that carries meaning (a symbol in a key, the border of a field) needs 3 to 1
// against what it sits on. The tokens are the palette of design 5.1; --c-blue-light and
// --c-blue-pale are for decorative tracks only. Task 11 N-1: the «قادم» cell was drawn in
// --c-blue-pale, 1.2 to 1.

const styles = join(resolve(import.meta.dirname, '..'), 'src', 'styles');
const tokens = readFileSync(join(styles, 'tokens.css'), 'utf8');
const components = readFileSync(join(styles, 'components.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

function token(name: string): string {
  const line = tokens.split(/\r?\n/).map((l) => l.trim()).find((l) => l.startsWith(`${name}:`));
  const hex = line?.slice(name.length + 1).trim().replace(';', '');
  if (!hex || !hex.startsWith('#')) throw new Error(`no token ${name}`);
  return hex;
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** The token a rule gives a property: `.heat-future { stroke: var(--c-blue) }` gives `--c-blue`. */
function ruleToken(selector: string, property: string): string {
  // Plain rules only: the text between the `}` before the selector and its own `}`.
  const blocks = components.split('}').map((b) => b.split('{'));
  const block = blocks.find(([head]) => (head ?? '').split(',').some((part) => part.trim() === selector));
  const body = block?.[1] ?? '';
  const value = body.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${property}:`));
  const match = value ? /var\((--[a-z0-9-]+)\)/.exec(value) : null;
  if (!match) throw new Error(`${selector} has no ${property}: var(--token)`);
  return match[1] as string;
}

describe('the contrast helper', () => {
  it('knows the extremes and the figures the design states', () => {
    expect(contrast('#000000', '#FFFFFF')).toBeCloseTo(21, 0);
    expect(contrast(token('--c-blue'), token('--c-surface'))).toBeGreaterThan(4.5);
    expect(contrast(token('--c-blue-pale'), token('--c-surface'))).toBeLessThan(1.5);
  });
});

describe('marks that carry meaning have 3 to 1 against the card', () => {
  const surface = token('--c-surface');
  it.each([
    ['.heat-future', 'stroke'],
    ['.heat-none', 'stroke'],
    ['.heat-done', 'fill'],
    ['.heat-off', 'fill'],
    ['.heat-skipped', 'stroke'],
    ['.heat-hatch', 'stroke'],
    ['.heat-today', 'stroke'],
  ])('%s %s', (selector, property) => {
    const name = ruleToken(selector, property);
    expect(contrast(token(name), surface), `${selector} uses ${name}`).toBeGreaterThanOrEqual(3);
  });
});

describe('and on the navy surface', () => {
  it('the light blue of a day to come has 3 to 1 against the ink', () => {
    expect(components).toContain(':is(.hero-card, .on-ink) .heat-future');
    expect(contrast(token('--c-blue-light'), token('--c-ink'))).toBeGreaterThanOrEqual(3);
  });
});
