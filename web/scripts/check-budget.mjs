// First-load JavaScript budget (web constraint: <= 80 KB gzip = 81920 bytes).
// Sums the gzip size of every JS file that dist/index.html loads: <script src> tags and
// <link rel="modulepreload"> chunks. Files index.html does not reference (sw.js) are ignored.
//
//   node scripts/check-budget.mjs [--dist <dir>]
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
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

let total = 0;
for (const ref of files) {
  const path = join(dist, ref.replace(/^\/+/, ''));
  if (!existsSync(path)) fail(`${ref} is referenced by index.html but missing from dist`);
  const size = gzipSync(readFileSync(path), { level: 9 }).length;
  total += size;
  console.log(`  ${ref}: ${size} bytes gzip`);
}

console.log(`first-load JS: ${total} / ${LIMIT} bytes gzip`);
if (total > LIMIT) fail(`first-load JS is ${total} bytes gzip, over the ${LIMIT} byte budget`);
