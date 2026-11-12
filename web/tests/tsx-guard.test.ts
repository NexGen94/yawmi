import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The stylesheet guard (styles.test.ts) keeps colors in tokens.css and direction logical in CSS.
// This is its counterpart for components: under src/shell and src/pages a .tsx file names colors
// only through var(--c-...) or currentColor, and inline styles never name a physical side.

const webRoot = resolve(import.meta.dirname, '..');
const GUARDED = ['src/shell', 'src/pages'];

const hexColor = /(?<![\w&])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/;
const colorFunction = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color-mix)\(/i;

// CSS named colors (CSS Color Level 4), without transparent and currentColor.
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

// A color-bearing JSX attribute or style key followed by a literal string value.
const colorSlot =
  /(?<![\w-])(?:color|fill|stroke|stop-?[cC]olor|flood-?[cC]olor|lighting-?[cC]olor|background(?:-?[cC]olor)?|border(?:-?[cC]olor)?|outline(?:-?[cC]olor)?|caret-?[cC]olor|accent-?[cC]olor|text-?[dD]ecoration-?[cC]olor|box-?[sS]hadow)\s*[:=]\s*\{?\s*(['"`])([^'"`]*)\1/g;

// Physical sides: CSS spelling (inside style strings) and the camelCase keys of style objects.
const physicalSide =
  /(?:^|[\s;{,(])(?:left|right)\s*:|(?<![\w-])(?:margin|padding|border|inset|scroll-margin|scroll-padding)-(?:left|right)\b|(?<![\w-])(?:margin|padding|border|inset|scrollMargin|scrollPadding)(?:Left|Right)\w*\s*:|border-(?:top|bottom)-(?:left|right)-radius|border(?:Top|Bottom)(?:Left|Right)Radius|(?:float|clear|text-align|textAlign)\s*:\s*['"]?(?:left|right)\b/m;

/** Every rule a source text breaks, as short labels. */
function violations(text: string): string[] {
  const found: string[] = [];
  const hex = hexColor.exec(text);
  if (hex) found.push(`hex color ${hex[0]}`);
  const fn = colorFunction.exec(text);
  if (fn) found.push(`color function ${fn[0]}`);
  for (const [, , value] of text.matchAll(colorSlot)) {
    for (const word of (value ?? '').toLowerCase().match(/[a-z]+/g) ?? []) {
      if (NAMED_COLORS.has(word)) found.push(`named color ${word}`);
    }
  }
  // A style written as a CSS string: every value in it.
  for (const [, , css] of text.matchAll(/(?<![\w-])style\s*=\s*\{?\s*(['"`])([^'"`]*)\1/g)) {
    for (const [, value] of (css ?? '').matchAll(/[\w-]+\s*:\s*([^;]+)/g)) {
      for (const word of (value ?? '').toLowerCase().match(/[a-z]+/g) ?? []) {
        if (NAMED_COLORS.has(word)) found.push(`named color ${word}`);
      }
    }
  }
  const side = physicalSide.exec(text);
  if (side) found.push(`physical side ${side[0].trim()}`);
  return found;
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

/** `file: violation` for every .tsx under the given directories. */
function scan(root: string, dirs: string[]): string[] {
  const out: string[] = [];
  for (const dir of dirs) {
    for (const file of walk(join(root, dir)).filter((f) => f.endsWith('.tsx'))) {
      for (const v of violations(readFileSync(file, 'utf8'))) {
        out.push(`${relative(root, file).replaceAll('\\', '/')}: ${v}`);
      }
    }
  }
  return out;
}

describe('the .tsx color and direction guard', () => {
  it.each([
    ['<div style={{ color: "red" }} />', 'named color'],
    ["<div style={{ background: 'white' }} />", 'named color'],
    ['<path fill="black" />', 'named color'],
    ["<circle stroke={'navy'} />", 'named color'],
    ['<p style="color: tomato" />', 'named color'],
    ['<div style={{ borderColor: "#1D3557" }} />', 'hex color'],
    ["<div style={{ color: 'rgb(0 0 0)' }} />", 'color function'],
    ["<div style={{ color: 'hsl(10 20% 30%)' }} />", 'color function'],
    ['<div style={{ marginLeft: 8 }} />', 'physical side'],
    ['<div style={{ paddingRight: 8 }} />', 'physical side'],
    ['<div style={{ left: 0 }} />', 'physical side'],
    ['<div style={{ right: 0 }} />', 'physical side'],
    ['<div style={{ borderLeftWidth: 1 }} />', 'physical side'],
    ["<div style={{ textAlign: 'left' }} />", 'physical side'],
    ["<div style={{ float: 'right' }} />", 'physical side'],
    ['<div style="margin-left: 8px" />', 'physical side'],
    ['<div style={{ borderTopRightRadius: 4 }} />', 'physical side'],
  ])('flags %s', (bad, rule) => {
    expect(violations(bad).join('; ')).toContain(rule);
  });

  it.each([
    '<div style={{ color: "var(--c-ink)" }} />',
    '<path fill="currentColor" />',
    '<path fill="none" stroke="currentColor" />',
    '<div style={{ background: "transparent" }} />',
    '<div style={{ marginInlineStart: 8, paddingInlineEnd: 8, insetInlineStart: 0 }} />',
    '<div style={{ textAlign: "start" }} />',
    '<text text-anchor="end">نص</text>',
    '<a href="#main">تخطي</a>',
    'const label = "أحمر وأبيض";',
  ])('spares %s', (good) => {
    expect(violations(good)).toEqual([]);
  });

  it('catches a violation planted in a .tsx file under a guarded folder, and ignores other files', () => {
    const root = mkdtempSync(join(tmpdir(), 'yawmi-tsx-guard-'));
    try {
      mkdirSync(join(root, 'src/shell'), { recursive: true });
      mkdirSync(join(root, 'src/pages/habits'), { recursive: true });
      writeFileSync(join(root, 'src/shell/Good.tsx'), '<nav style={{ color: "var(--c-bg)" }} />');
      writeFileSync(join(root, 'src/pages/habits/Bad.tsx'), "<div style={{ marginLeft: 4, color: 'red' }} />");
      writeFileSync(join(root, 'src/pages/habits/notes.ts'), "const style = { left: 0, color: 'red' };");
      expect(scan(root, GUARDED)).toEqual([
        'src/pages/habits/Bad.tsx: named color red',
        'src/pages/habits/Bad.tsx: physical side marginLeft:',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('src/shell and src/pages exist and hold .tsx files', () => {
    for (const dir of GUARDED) {
      expect(walk(join(webRoot, dir)).filter((f) => f.endsWith('.tsx')).length, dir).toBeGreaterThan(0);
    }
  });

  it('no .tsx under src/shell or src/pages names a color literal or a physical side', () => {
    expect(scan(webRoot, GUARDED)).toEqual([]);
  });
});
