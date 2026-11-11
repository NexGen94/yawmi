// First-load JavaScript budget (web constraint: <= 80 KB gzip = 81920 bytes).
// Sums the gzip size of every JS file that dist/index.html loads: <script src> tags and
// <link rel="modulepreload"> chunks. Files index.html does not reference (sw.js) are ignored.
// It then follows the relative imports of those files, static and dynamic, because the app
// fetches them at start-up too (registerSW imports workbox-window). The lazy page chunks are the
// exception: they load on navigation, so they are not followed.
// Every page but home is lazy (vite.config.ts names their chunks page-<name>-[hash].js), so a
// page chunk other than page-home that index.html itself loads fails the check whatever its size.
//
//   node scripts/check-budget.mjs [--dist <dir>]
import { existsSync, readFileSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const LIMIT = 81920;

const argIndex = process.argv.indexOf('--dist');
const distArg = argIndex === -1 ? undefined : process.argv[argIndex + 1];
const dist = resolve(distArg ?? join(import.meta.dirname, '..', 'dist'));

const fail = (message) => {
  console.error(`check-budget: ${message}`);
  process.exit(1);
};

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

const isLazyPage = (ref) => {
  const name = ref.split('/').pop() ?? '';
  return name.startsWith('page-') && !name.startsWith('page-home-');
};

const eagerPages = files.filter(isLazyPage);
if (eagerPages.length > 0) {
  fail(`index.html loads lazy page chunks in the first load: ${eagerPages.join(', ')} (only page-home may load first)`);
}

// import("./x.js"), import(`./x.js`), import"./x.js", from"./x.js": relative specifiers only.
const IMPORT = /\b(?:import\s*\(\s*|import\s*|from\s*)(["'`])(\.{1,2}\/[^"'`]+?\.m?js)\1/g;

const seen = new Set();
const queue = files.map((ref) => posix.normalize('/' + ref.replace(/^\/+/, '')));
let total = 0;
while (queue.length > 0) {
  const ref = queue.shift();
  if (seen.has(ref)) continue;
  seen.add(ref);
  const path = join(dist, ref.slice(1));
  if (!existsSync(path)) fail(`${ref} is loaded on first load but missing from dist`);
  const code = readFileSync(path);
  const size = gzipSync(code, { level: 9 }).length;
  total += size;
  console.log(`  ${ref}: ${size} bytes gzip`);
  for (const [, , spec] of code.toString('utf8').matchAll(IMPORT)) {
    const target = posix.join(posix.dirname(ref), spec);
    if (!isLazyPage(target) && !seen.has(target)) queue.push(target);
  }
}

console.log(`first-load JS: ${total} / ${LIMIT} bytes gzip`);
if (total > LIMIT) fail(`first-load JS is ${total} bytes gzip, over the ${LIMIT} byte budget`);
