import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The component layer (src/ui, src/charts) draws with SVG attributes and inline styles, which the
// stylesheet guard in styles.test.ts does not read. This guard extends the two rules of the design
// (section 5.1) to those files: colours only through the tokens (var(--c-...), currentColor), and
// logical directions only.

const webRoot = resolve(import.meta.dirname, '..');
const DIRS = ['src/ui', 'src/charts'].map((d) => join(webRoot, d));
const rel = (path: string): string => relative(webRoot, path).replaceAll('\\', '/');

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const NAMED = (
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
  'teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen ' +
  // System colours are colours too: the tokens decide every colour.
  'canvas canvastext linktext visitedtext activetext buttonface buttontext buttonborder fieldtext ' +
  'highlight highlighttext selecteditem selecteditemtext marktext graytext accentcolor accentcolortext'
).split(' ');
const NAMED_SET = new Set(NAMED);

const strip = (code: string): string => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const HEX = /(?<![\w&])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g;
const COLOR_FUNCTION = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\(/gi;
// Paint attributes in JSX (fill="...", stopColor='...') and paint keys in style objects or strings.
const PAINT =
  /\b(fill|stroke|color|stop-?color|flood-?color|lighting-?color|caret-?color|accent-?color|text-?decoration-?color|column-?rule-?color|background[\w-]*|border[\w-]*|outline[\w-]*|box-?shadow|text-?shadow)\s*[=:]\s*\{?\s*["'`]([^"'`]*)["'`]/gi;
const ALLOWED_PAINT = /^(?:none|currentColor|transparent|inherit|url\(#[^)]*\)|var\(--c-[\w-]+\)|\$\{[^}]*\})$/i;

/** Colour literals in a component source: hex, colour functions, a named or system colour as a
 *  whole string literal or as a value inside CSS text, and paint attributes or style keys whose
 *  value names a colour. */
function colourLiterals(source: string): string[] {
  const code = strip(source);
  const found: string[] = [];
  for (const hex of code.matchAll(HEX)) found.push(hex[0]);
  for (const fn of code.matchAll(COLOR_FUNCTION)) found.push(fn[0]);
  const named = (text: string): string[] =>
    (text.toLowerCase().match(/[a-z]+/g) ?? []).filter((word) => NAMED_SET.has(word));
  for (const [, literal = ''] of code.matchAll(/["'`]([^"'`\n]*)["'`]/g)) {
    if (NAMED_SET.has(literal.trim().toLowerCase())) found.push(literal);
    for (const [, value = ''] of literal.matchAll(/[\w-]+\s*:\s*([^;]+)/g)) found.push(...named(value));
  }
  for (const [whole, , value = ''] of code.matchAll(PAINT)) {
    if (!ALLOWED_PAINT.test(value.trim()) && named(value).length > 0) found.push(whole);
  }
  return found;
}

// Physical sides in inline styles: style objects (marginLeft, paddingRight, borderLeftWidth, left:,
// right:), CSS text (margin-left, left:), and values that name a side (textAlign: 'left').
const PHYSICAL_KEY =
  /(?:^|[\s{,;"'`(])(?:(?:margin|padding|border|inset|scrollMargin|scrollPadding)(?:Left|Right)\w*|(?:margin|padding|border|inset|scroll-margin|scroll-padding)-(?:left|right)\b|border(?:Top|Bottom)(?:Left|Right)Radius|border-(?:top|bottom)-(?:left|right)-radius|left|right)\s*:/;
const PHYSICAL_VALUE =
  /\b(?:textAlign|text-align|float|clear|backgroundPosition|background-position|transformOrigin|transform-origin|objectPosition|object-position)\s*:\s*["'`]?[^,;}"'`]*\b(?:left|right)\b/i;

function physicalDirections(source: string): string[] {
  const code = strip(source);
  const found: string[] = [];
  for (const line of code.split('\n')) {
    if (PHYSICAL_KEY.test(line)) found.push(line.trim());
    else if (PHYSICAL_VALUE.test(line)) found.push(line.trim());
  }
  return found;
}

describe('the component guard catches what it must', () => {
  it('flags colour literals', () => {
    for (const bad of [
      `<rect fill="red" />`,
      `<circle stroke='White' />`,
      `<p style={{ color: 'rgb(1,2,3)' }} />`,
      `<p style={{ background: 'hsl(1 2% 3%)' }} />`,
      `<stop stopColor="navy" />`,
      `const c = '#E63946';`,
      `<p style="color: tomato" />`,
      `<p style={{ borderColor: 'black' }} />`,
      `<rect fill={'Canvas'} />`,
      `const tone = 'red';`,
    ]) {
      expect(colourLiterals(bad), bad).not.toEqual([]);
    }
  });

  it('spares the allowed paints and ordinary words', () => {
    for (const good of [
      `<rect fill="none" />`,
      `<rect fill="currentColor" />`,
      `<rect fill={\`url(#\${id})\`} />`,
      `<rect fill="url(#hatch)" />`,
      `<p style={{ color: 'var(--c-ink)' }} />`,
      `<rect class="ring-arc" />`,
      `const label = 'إنجاز اليوم';`,
      `// fill="red" in a comment`,
      `<button type="button" />`,
      `<p class="badge badge-signal" />`,
    ]) {
      expect(colourLiterals(good), good).toEqual([]);
    }
  });

  it('flags physical directions in inline styles', () => {
    for (const bad of [
      `<p style={{ marginLeft: 4 }} />`,
      `<p style={{ paddingRight: '4px' }} />`,
      `<p style={{ left: 0 }} />`,
      `<p style={{ right: 0 }} />`,
      `<p style="margin-left: 4px" />`,
      `<p style="left: 0" />`,
      `<p style={{ textAlign: 'left' }} />`,
      `<p style={{ float: 'right' }} />`,
      `<p style={{ borderTopLeftRadius: 4 }} />`,
      `<p style={{ insetLeft: 0 }} />`,
    ]) {
      expect(physicalDirections(bad), bad).not.toEqual([]);
    }
  });

  it('spares logical properties and SVG coordinates', () => {
    for (const good of [
      `<p style={{ marginInlineStart: 4 }} />`,
      `<p style={{ paddingInline: 8, insetInlineEnd: 0 }} />`,
      `<p style={{ blockSize: '22px', inlineSize: '40%' }} />`,
      `<p style={{ textAlign: 'start' }} />`,
      `<rect x={x(i, n, width)} y={0} />`,
      `<text text-anchor="end" />`,
      `const leftover = 3;`,
    ]) {
      expect(physicalDirections(good), good).toEqual([]);
    }
  });
});

const files = DIRS.flatMap(walk).filter((file) => /\.(tsx?|jsx?)$/.test(file));
const tsxFiles = files.filter((file) => file.endsWith('.tsx'));

describe('src/ui and src/charts', () => {
  it('have the component files', () => {
    expect(tsxFiles.length).toBeGreaterThanOrEqual(20);
    expect(files.length).toBeGreaterThanOrEqual(21);
  });

  it.each(files.map((file) => [rel(file), file] as const))('%s has no colour literal', (_name, file) => {
    expect(colourLiterals(readFileSync(file, 'utf8'))).toEqual([]);
  });

  it.each(files.map((file) => [rel(file), file] as const))('%s has no physical direction', (_name, file) => {
    expect(physicalDirections(readFileSync(file, 'utf8'))).toEqual([]);
  });
});
