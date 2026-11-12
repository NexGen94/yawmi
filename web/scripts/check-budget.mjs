// First-load JavaScript budget (web constraint: <= 80 KB gzip = 81920 bytes).
// Sums the gzip size of every JS file that dist/index.html loads: <script src> tags and
// <link rel="modulepreload"> chunks. Files index.html does not reference (sw.js) are ignored.
// It then follows the relative imports of those files: static imports unconditionally, and dynamic
// imports except lazy page chunks (page-<name>-[hash].js, loaded on navigation).
// Home is eager and inlined into the entry chunk, so any page-* chunk in the first load (or any
// non-home module under src/pages/ reachable via static imports from src/main.tsx) fails the check.
//
//   node scripts/check-budget.mjs [--dist <dir>]
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, posix, relative, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const LIMIT = 81920;

const argIndex = process.argv.indexOf('--dist');
const distArg = argIndex === -1 ? undefined : process.argv[argIndex + 1];
const dist = resolve(distArg ?? join(import.meta.dirname, '..', 'dist'));

const fail = (message) => {
  console.error(`check-budget: ${message}`);
  process.exit(1);
};

const resolveSourceModule = (fromFile, spec) => {
  const base = resolve(dirname(fromFile), spec);
  for (const suffix of ['', '.ts', '.tsx', '/index.ts', '/index.tsx']) {
    const candidate = base + suffix;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
};

const STATIC_SRC_IMPORT =
  /(?:^|[\r\n;])\s*(?:import|export)\b(?:(?!\btype\b)[^;\r\n])*?\bfrom\s*(['"])(\.{1,2}\/[^'"]+)\1|(?:^|[\r\n;])\s*import\s*(['"])(\.{1,2}\/[^'"]+)\3/g;
const NON_HOME_PAGE = /[\\/]src[\\/]pages[\\/](?!home(?:[\\/]|$))[\w-]+/;

const leakedPages = [];
const srcEntry = resolve(dist, '..', 'src', 'main.tsx');
if (existsSync(srcEntry)) {
  const webRoot = resolve(dist, '..');
  const seenSrc = new Set();
  const srcQueue = [srcEntry];
  while (srcQueue.length > 0) {
    const current = srcQueue.shift();
    if (seenSrc.has(current)) continue;
    seenSrc.add(current);
    if (NON_HOME_PAGE.test(current)) {
      leakedPages.push(relative(webRoot, current).replaceAll('\\', '/'));
    }
    const srcText = readFileSync(current, 'utf8');
    for (const match of srcText.matchAll(STATIC_SRC_IMPORT)) {
      const spec = match[2] ?? match[4];
      if (!spec) continue;
      const target = resolveSourceModule(current, spec);
      if (target && !seenSrc.has(target)) srcQueue.push(target);
    }
  }
}

const indexPath = join(dist, 'index.html');
if (!existsSync(indexPath)) fail(`${indexPath} not found; run "npm run build" first`);
const html = readFileSync(indexPath, 'utf8');

const attr = (tag, name) => new RegExp(`\\s${name}\\s*=\\s*["']([^"']+)["']`, 'i').exec(tag)?.[1];

const refs = new Set();
for (const [tag] of html.matchAll(/<script\b[^>]*>/gi)) {
  const src = attr(tag, 'src');
  if (src) refs.add(src);
}
for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
  const rel = attr(tag, 'rel') ?? '';
  const href = attr(tag, 'href');
  if (href && rel.split(/\s+/).includes('modulepreload')) refs.add(href);
}

const files = [...refs]
  .map((ref) => ref.split(/[?#]/)[0] ?? '')
  .filter((ref) => ref.endsWith('.js') || ref.endsWith('.mjs'));
if (files.length === 0) fail('index.html references no JavaScript');

const isPageChunk = (ref) => {
  const name = ref.split('/').pop() ?? '';
  return name.startsWith('page-');
};

// import("./x.js"), import(`./x.js`), import"./x.js", from"./x.js": relative specifiers only.
const IMPORT = /\b(import\s*\(\s*|import\s*|from\s*)(["'`])(\.{1,2}\/[^"'`]+?\.m?js)\2/g;

const seen = new Set();
const eagerPages = [];
const queue = files.map((ref) => posix.normalize('/' + ref.replace(/^\/+/, '')));
let total = 0;
while (queue.length > 0) {
  const ref = queue.shift();
  if (seen.has(ref)) continue;
  seen.add(ref);
  if (isPageChunk(ref)) eagerPages.push(ref);
  const path = join(dist, ref.slice(1));
  if (!existsSync(path)) fail(`${ref} is loaded on first load but missing from dist`);
  const code = readFileSync(path);
  const size = gzipSync(code, { level: 9 }).length;
  total += size;
  console.log(`  ${ref}: ${size} bytes gzip`);
  for (const [, kind, , spec] of code.toString('utf8').matchAll(IMPORT)) {
    const target = posix.join(posix.dirname(ref), spec);
    const isDynamic = (kind ?? '').includes('(');
    if ((isDynamic ? !isPageChunk(target) : true) && !seen.has(target)) queue.push(target);
  }
}

console.log(`first-load JS: ${total} / ${LIMIT} bytes gzip`);
const errors = [];
if (leakedPages.length > 0) {
  errors.push(`first-load module graph includes non-home page modules: ${leakedPages.join(', ')}`);
}
if (eagerPages.length > 0) {
  errors.push(`first-load JS includes page chunks: ${eagerPages.join(', ')}`);
}
if (total > LIMIT) {
  errors.push(`first-load JS is ${total} bytes gzip, over the ${LIMIT} byte budget`);
}
if (errors.length > 0) fail(errors.join('; '));
