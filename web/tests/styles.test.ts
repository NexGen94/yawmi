import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { pwaOptions } from '../pwa.config';

const webRoot = resolve(import.meta.dirname, '..');
const src = join(webRoot, 'src');
const styles = join(src, 'styles');
const read = (path: string): string => readFileSync(path, 'utf8');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const cssFiles = walk(styles).filter((file) => file.endsWith('.css'));
const tokens = join(styles, 'tokens.css');
const rel = (path: string): string => relative(webRoot, path).replaceAll('\\', '/');

// The ten colors of the design (section 5.1), as written there.
const PALETTE = [
  '#F1FAEE', // --c-bg
  '#FFFFFF', // --c-surface
  '#1D3557', // --c-ink
  '#3B6A89', // --c-ink-2
  '#457B9D', // --c-blue
  '#A8DADC', // --c-blue-light
  '#DCEFEF', // --c-blue-pale
  '#E63946', // --c-signal
  '#B8232F', // --c-signal-ink
  '#FCE4E6', // --c-signal-bg
];

// #rgb, #rgba, #rrggbb, #rrggbbaa that are not part of a longer word or an HTML entity.
const hexColor = /(?<![\w&])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g;
const colorFunction = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\(/i;
// CSS custom property declarations: `--name: value;`
const declaration = /(--[\w-]+)\s*:\s*([^;}]+);/g;

function tokenMap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const [, name, value] of read(tokens).matchAll(declaration)) {
    map.set(name ?? '', (value ?? '').trim());
  }
  return map;
}

describe('physical direction is banned in src/styles', () => {
  const physical =
    /(?:^|[\s;{])(?:left|right)\s*:|(?<![\w-])(?:margin|padding|border|inset|scroll-margin|scroll-padding)-(?:left|right)\b|border-(?:top|bottom)-(?:left|right)-radius|(?:float|clear|text-align)\s*:\s*(?:left|right)\b/im;

  it('the checker flags the four properties the plan names', () => {
    for (const bad of ['a{left:0}', 'a{right:0}', 'a{margin-left:1px}', 'a{padding-right:1px}']) {
      expect(bad).toMatch(physical);
    }
  });

  it('has the files that 4b and 4c fill', () => {
    for (const name of ['tokens.css', 'base.css', 'components.css', 'layout.css', 'index.css']) {
      expect(existsSync(join(styles, name)), name).toBe(true);
    }
  });

  it.each(cssFiles.map((file) => [rel(file), file] as const))(
    '%s has no left, right, margin-left or padding-right',
    (_name, file) => {
      expect(read(file)).not.toMatch(physical);
    },
  );
});

describe('colors live in tokens.css only', () => {
  it('tokens.css holds exactly the ten palette values of section 5.1', () => {
    const found = new Set([...read(tokens).matchAll(hexColor)].map((m) => m[0].toUpperCase()));
    expect([...found].sort()).toEqual([...PALETTE].sort());
  });

  it('every hex color anywhere under src/ is in tokens.css and nowhere else', () => {
    const offenders: string[] = [];
    for (const file of walk(src)) {
      if (file === tokens) continue;
      if (!/\.(css|ts|tsx|html|svg)$/.test(file)) continue;
      for (const match of read(file).matchAll(hexColor)) offenders.push(`${rel(file)}: ${match[0]}`);
    }
    expect(offenders).toEqual([]);
  });

  it('no stylesheet other than tokens.css writes a color function (rgb, hsl, oklch, color-mix)', () => {
    for (const file of cssFiles) {
      if (file === tokens) continue;
      expect(read(file), rel(file)).not.toMatch(colorFunction);
    }
  });

  it('every var(--...) used in a stylesheet is defined in tokens.css', () => {
    const defined = tokenMap();
    for (const file of cssFiles) {
      for (const [, name] of read(file).matchAll(/var\((--[\w-]+)/g)) {
        expect(defined.has(name ?? ''), `${rel(file)} uses ${name}`).toBe(true);
      }
    }
  });
});

describe('tokens.css values (design section 5.1)', () => {
  const expected: Record<string, string> = {
    '--c-bg': '#F1FAEE',
    '--c-surface': '#FFFFFF',
    '--c-ink': '#1D3557',
    '--c-ink-2': '#3B6A89',
    '--c-blue': '#457B9D',
    '--c-blue-light': '#A8DADC',
    '--c-blue-pale': '#DCEFEF',
    '--c-signal': '#E63946',
    '--c-signal-ink': '#B8232F',
    '--c-signal-bg': '#FCE4E6',
    '--font': '"IBM Plex Sans Arabic", system-ui, sans-serif',
    '--fs-title': '28px',
    '--fs-section': '17px',
    '--fs-body': '15px',
    '--fs-note': '13px',
    '--fs-min': '11px',
    '--fs-num': '22px',
    '--fs-num-lg': '56px',
    '--lh': '1.5',
    '--sp-1': '4px',
    '--sp-2': '8px',
    '--sp-3': '12px',
    '--sp-4': '16px',
    '--sp-5': '20px',
    '--sp-6': '24px',
    '--sp-7': '32px',
    '--sp-8': '40px',
    '--radius-card': '20px',
    '--radius-hero': '28px',
    '--radius-pill': '999px',
    '--hit': '44px',
    '--sidebar-w': '248px',
    '--content-max': '1120px',
    '--focus': '0 0 0 3px #457B9D',
    '--focus-on-ink': '0 0 0 3px #A8DADC',
  };

  it.each(Object.entries(expected))('%s is %s', (name, value) => {
    expect(tokenMap().get(name)).toBe(value);
  });

  it('declares nothing the design does not list', () => {
    expect([...tokenMap().keys()].sort()).toEqual(Object.keys(expected).sort());
  });
});

describe('index.css', () => {
  const index = read(join(styles, 'index.css'));
  const imports = [...index.matchAll(/@import\s+(?:url\()?['"]([^'"]+)['"]/g)].map((m) => m[1] ?? '');

  it('imports tokens, base, components, layout in that order, then styles the body from tokens', () => {
    expect(imports.filter((name) => name.startsWith('./'))).toEqual([
      './tokens.css',
      './base.css',
      './components.css',
      './layout.css',
    ]);
    expect(index).toMatch(
      /body\s*\{[^}]*font-family:\s*var\(--font\);[^}]*background:\s*var\(--c-bg\);[^}]*color:\s*var\(--c-ink\);[^}]*\}/s,
    );
  });

  it('self-hosts only weights 400 and 600 of the Arabic subset, ahead of the app styles', () => {
    const fonts = imports.filter((name) => name.startsWith('@fontsource/'));
    expect(fonts).toEqual([
      '@fontsource/ibm-plex-sans-arabic/arabic-400.css',
      '@fontsource/ibm-plex-sans-arabic/arabic-600.css',
    ]);
    for (const font of fonts) {
      const css = read(join(webRoot, 'node_modules', font));
      expect(css).toContain('font-display: swap');
      expect(css).toContain("font-family: 'IBM Plex Sans Arabic'");
    }
    expect(imports.indexOf(fonts[1] ?? '')).toBeLessThan(imports.indexOf('./tokens.css'));
  });

  it('keeps font files out of the service worker precache list', () => {
    const patterns = (pwaOptions as { injectManifest?: { globPatterns?: string[] } }).injectManifest?.globPatterns;
    // Unset means the plugin default (js, css, html). If someone sets it, no font extension.
    for (const pattern of patterns ?? []) expect(pattern).not.toMatch(/woff2?|ttf|otf/);
  });
});

describe('main.tsx', () => {
  it('loads the aggregate stylesheet, not base.css alone', () => {
    const main = read(join(src, 'main.tsx'));
    expect(main).toContain("import './styles/index.css'");
    expect(main).not.toContain("'./styles/base.css'");
  });
});
