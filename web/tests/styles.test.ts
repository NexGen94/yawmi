import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

// Detectors are plain functions or patterns so that their own tests can prove each rule catches
// a violation.
const physicalProperty =
  /(?:^|[\s;{])(?:left|right)\s*:|(?<![\w-])(?:margin|padding|border|inset|scroll-margin|scroll-padding)-(?:left|right)\b|border-(?:top|bottom)-(?:left|right)-radius|(?:float|clear|text-align)\s*:\s*(?:left|right)\b/im;
// Values that name a physical side: `background-position: left top`, `transform-origin: right`.
const physicalValue =
  /(?<![\w-])(?:background-position|object-position|mask-position|transform-origin|text-align-last)\s*:[^;}]*\b(?:left|right)\b/im;

// CSS named colors (CSS Color Level 4), without the non-colors transparent and currentColor.
const NAMED_COLORS = new Set(
  (
    'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown ' +
    'burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan ' +
    'darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid ' +
    'darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet ' +
    'deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ' +
    'ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki ' +
    'lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow ' +
    'lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray ' +
    'lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine ' +
    'mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise ' +
    'mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab ' +
    'orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru ' +
    'pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown ' +
    'seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan ' +
    'teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen'
  ).split(' '),
);

/** Named colors used as a value, ignoring comments, quoted strings and url(). */
function colorKeywords(css: string): string[] {
  const plain = css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/url\([^)]*\)/gi, '')
    .replace(/"[^"]*"|'[^']*'/g, '');
  const found: string[] = [];
  for (const [, , value] of plain.matchAll(/([\w-]+)\s*:\s*([^;{}]+)(?=[;}])/g)) {
    for (const word of (value ?? '').toLowerCase().match(/[a-z]+(?:-[a-z]+)*/g) ?? []) {
      if (NAMED_COLORS.has(word)) found.push(word);
    }
  }
  return found;
}

const pkg = join(webRoot, 'node_modules', '@fontsource', 'ibm-plex-sans-arabic');
const squash = (text: string): string => text.replace(/\s+/g, '');

// The package's own 400.css and 600.css hold the unicode-range of each subset.
function packageRange(subset: string, weight: string): string {
  const css = read(join(pkg, `${weight}.css`));
  const start = css.indexOf(`/* ibm-plex-sans-arabic-${subset}-${weight}-normal */`);
  const block = start === -1 ? '' : css.slice(start, css.indexOf('}', start));
  return squash(/unicode-range:\s*([^;]+);/.exec(block)?.[1] ?? '');
}

/** unicode-range text as sorted, merged [from, to] code point intervals. The minifier rewrites
 *  U+0600-06FF as U+6?? and U+0000-00FF as U+??, so ranges are compared by meaning, not text. */
function codePointRanges(text: string): string {
  const spans: [number, number][] = [];
  for (const [, from, to] of text.matchAll(/U\+([0-9a-f?]+)(?:-([0-9a-f]+))?/gi)) {
    const start = parseInt((from ?? '').replace(/\?/g, '0'), 16);
    const end = to ? parseInt(to, 16) : parseInt((from ?? '').replace(/\?/g, 'f'), 16);
    spans.push([start, end]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span[0] <= last[1] + 1) last[1] = Math.max(last[1], span[1]);
    else merged.push([...span]);
  }
  return merged.map(([a, b]) => a.toString(16) + '-' + b.toString(16)).join(',');
}

function tokenMap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const [, name, value] of read(tokens).matchAll(declaration)) {
    map.set(name ?? '', (value ?? '').trim());
  }
  return map;
}

describe('physical direction is banned in src/styles', () => {
  it('the checker flags the properties the plan names and the physical values', () => {
    for (const bad of [
      'a{left:0}',
      'a{right:0}',
      'a{margin-left:1px}',
      'a{padding-right:1px}',
      'a{text-align:left}',
      'a{text-align: right}',
      'a{float:left}',
      'a{float: right}',
    ]) {
      expect(bad).toMatch(physicalProperty);
    }
    for (const bad of [
      'a{background-position:left top}',
      'a{background-position: 100% right}',
      'a{transform-origin:right}',
      'a{object-position: left}',
    ]) {
      expect(bad).toMatch(physicalValue);
    }
    for (const good of [
      'a{text-align:start}',
      'a{float:inline-start}',
      'a{background-position:center}',
      'a{inset-inline-start:0}',
      'a{padding-inline:max(env(safe-area-inset-left),env(safe-area-inset-right))}',
    ]) {
      expect(good).not.toMatch(physicalProperty);
      expect(good).not.toMatch(physicalValue);
    }
  });

  it('has the files that 4b and 4c fill', () => {
    for (const name of ['tokens.css', 'base.css', 'components.css', 'layout.css', 'index.css']) {
      expect(existsSync(join(styles, name)), name).toBe(true);
    }
  });

  it.each(cssFiles.map((file) => [rel(file), file] as const))(
    '%s has no physical direction (left, right, margin-left, padding-right, text-align, float, positions)',
    (_name, file) => {
      expect(read(file)).not.toMatch(physicalProperty);
      expect(read(file)).not.toMatch(physicalValue);
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

  it('the keyword checker flags named colors and spares non-colors', () => {
    for (const bad of ['a{color:red}', 'a{background:white}', 'a{border:1px solid Black}', 'a{fill:rebeccapurple}']) {
      expect(colorKeywords(bad), bad).not.toEqual([]);
    }
    for (const good of [
      'a{color:var(--c-ink)}',
      'a{background:transparent}',
      'a{color:currentColor}',
      'a{font-family:"Red Hat Display", system-ui}',
      'a{background:url(white.png)}',
      '/* color: red; */ a{display:grid}',
      'a{margin:0}',
    ]) {
      expect(colorKeywords(good), good).toEqual([]);
    }
  });

  it('the function checker flags rgb() and hsl()', () => {
    for (const bad of ['a{color:rgb(1,2,3)}', 'a{color:RGBA(0 0 0 / .5)}', 'a{color:hsl(10 20% 30%)}']) {
      expect(bad).toMatch(colorFunction);
    }
    expect('a{color:var(--c-ink)}').not.toMatch(colorFunction);
  });

  it('no stylesheet other than tokens.css names a color (red, white, ...)', () => {
    for (const file of cssFiles) {
      if (file === tokens) continue;
      expect(colorKeywords(read(file)), rel(file)).toEqual([]);
    }
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
    '--font-code': '"Segoe UI", system-ui, Arial, sans-serif',
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
  const faces = [...index.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1] ?? '');
  const field = (block: string, name: string): string =>
    new RegExp(`${name}:\\s*([^;]+);`).exec(block)?.[1]?.trim() ?? '';

  it('imports tokens, base, components, layout in that order, then styles the body from tokens', () => {
    expect(imports).toEqual(['./tokens.css', './base.css', './components.css', './layout.css']);
    expect(index).toMatch(
      /body\s*\{[^}]*font-family:\s*var\(--font\);[^}]*background:\s*var\(--c-bg\);[^}]*color:\s*var\(--c-ink\);[^}]*\}/s,
    );
  });

  it('self-hosts the Arabic and Latin subsets of weights 400 and 600, no other weight or subset', () => {
    // The package's per-subset stylesheets carry no unicode-range, so they are not imported.
    expect(imports.filter((name) => name.startsWith('@fontsource/'))).toEqual([]);
    const seen = faces.map(
      (block) => `${/-(arabic|latin)-\d+-normal\.woff2/.exec(block)?.[1]}-${field(block, 'font-weight')}`,
    );
    expect(seen.sort()).toEqual(['arabic-400', 'arabic-600', 'latin-400', 'latin-600']);
  });

  it.each([
    ['arabic', '400'],
    ['arabic', '600'],
    ['latin', '400'],
    ['latin', '600'],
  ])('the %s %s face has swap, its own unicode-range and files that exist', (subset, weight) => {
    const block = faces.find((b) => b.includes(`-${subset}-${weight}-normal.woff2`)) ?? '';
    expect(block, 'face is declared').not.toBe('');
    expect(field(block, 'font-family')).toBe("'IBM Plex Sans Arabic'");
    expect(field(block, 'font-display')).toBe('swap');
    expect(field(block, 'font-weight')).toBe(weight);
    expect(field(block, 'font-style')).toBe('normal');
    expect(squash(field(block, 'unicode-range'))).toBe(packageRange(subset, weight));
    expect(packageRange(subset, weight)).toMatch(/^U\+/);
    for (const ext of ['woff2', 'woff']) {
      expect(existsSync(join(pkg, 'files', `ibm-plex-sans-arabic-${subset}-${weight}-normal.${ext}`))).toBe(true);
    }
  });

  it('keeps font files out of the service worker precache list', () => {
    const patterns = (pwaOptions as { injectManifest?: { globPatterns?: string[] } }).injectManifest?.globPatterns;
    // Unset means the plugin default (js, css, html). If someone sets it, no font extension.
    for (const pattern of patterns ?? []) expect(pattern).not.toMatch(/woff2?|ttf|otf/);
  });

  it('sets numeric text from the number tokens in tabular figures', () => {
    expect(index).toMatch(
      /\.num\s*\{[^}]*font-size:\s*var\(--fs-num\);[^}]*font-variant-numeric:\s*tabular-nums;[^}]*\}/s,
    );
    expect(index).toMatch(
      /\.num-lg\s*\{[^}]*font-size:\s*var\(--fs-num-lg\);[^}]*font-variant-numeric:\s*tabular-nums;[^}]*\}/s,
    );
  });
});

describe('the built CSS (vite build)', () => {
  it('declares both subsets at 400 and 600 with unicode-range and swap, and no font in the precache', () => {
    const out = mkdtempSync(join(tmpdir(), 'yawmi-font-build-'));
    try {
      const viteBin = join(webRoot, 'node_modules', 'vite', 'bin', 'vite.js');
      const run = spawnSync(process.execPath, [viteBin, 'build', '--outDir', out, '--emptyOutDir'], {
        cwd: webRoot,
        encoding: 'utf8',
      });
      expect(run.status, run.stderr + run.stdout).toBe(0);

      const assets = join(out, 'assets');
      const css = readdirSync(assets)
        .filter((file) => file.endsWith('.css'))
        .map((file) => read(join(assets, file)))
        .join('\n');
      const faces = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1] ?? '');
      expect(faces).toHaveLength(4);
      const seen = new Set<string>();
      for (const block of faces) {
        const subset = /-(arabic|latin)-\d+-normal-[\w-]+\.woff2/.exec(block)?.[1] ?? '';
        const weight = /font-weight:\s*(\d+)/.exec(block)?.[1] ?? '';
        expect(subset, block).not.toBe('');
        expect(block).toMatch(/font-display:\s*swap/);
        const range = /unicode-range:([^;}]+)/.exec(block)?.[1] ?? '';
        expect(range, block).not.toBe('');
        expect(codePointRanges(range), subset + ' ' + weight).toBe(codePointRanges(packageRange(subset, weight)));
        seen.add(subset + '-' + weight);
      }
      expect([...seen].sort()).toEqual(['arabic-400', 'arabic-600', 'latin-400', 'latin-600']);

      expect(readdirSync(assets).filter((file) => file.endsWith('.woff2'))).toHaveLength(4);
      expect(read(join(out, 'sw.js'))).not.toMatch(/woff/);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('main.tsx', () => {
  it('loads the aggregate stylesheet, not base.css alone', () => {
    const main = read(join(src, 'main.tsx'));
    expect(main).toContain("import './styles/index.css'");
    expect(main).not.toContain("'./styles/base.css'");
  });
});

describe('media queries (Task 24)', () => {
  it('use width, never inline-size or block-size: those are container features, and a rule under them never applies', () => {
    const all = walk(src).filter((file) => file.endsWith('.css'));
    expect(all.length).toBeGreaterThan(10);
    for (const file of all) {
      const text = read(file).replace(/\/\*[\s\S]*?\*\//g, '');
      for (const [query] of text.matchAll(/@media[^{]*\{/g)) {
        expect(query, `${rel(file)}`).not.toMatch(/(?:min-|max-)?(?:inline|block)-size\s*[:<>=]/);
      }
    }
  });
});
