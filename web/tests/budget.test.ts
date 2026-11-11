import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import viteConfig from '../vite.config';

const webRoot = resolve(import.meta.dirname, '..');
const script = join(webRoot, 'scripts/check-budget.mjs');
const made: string[] = [];

/** Runs check-budget.mjs against a throwaway dist folder holding the given files. */
function run(files: Record<string, string | Buffer>) {
  const dist = mkdtempSync(join(tmpdir(), 'yawmi-budget-'));
  made.push(dist);
  mkdirSync(join(dist, 'assets'));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dist, name), content);
  return spawnSync(process.execPath, [script, '--dist', dist], { encoding: 'utf8' });
}

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const html = (head: string): string => `<!doctype html><html><head>${head}</head><body></body></html>`;
const entry = '<script type="module" crossorigin src="/assets/index-abc.js"></script>';
// Random bytes do not compress, so the gzip size tracks the input size.
const noise = (bytes: number): Buffer => Buffer.from(Array.from({ length: bytes }, () => Math.floor(Math.random() * 256)));

describe('check-budget.mjs: only the home page may load first', () => {
  it('fails when index.html points at a page chunk other than home (page-habits-abc.js)', () => {
    const result = run({
      'index.html': html(entry + '<link rel="modulepreload" crossorigin href="/assets/page-habits-abc.js">'),
      'assets/index-abc.js': 'console.log(1)',
      'assets/page-habits-abc.js': 'console.log(2)',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('page-habits-abc.js');
  });

  it('fails for a page chunk loaded by a script tag too, and for a sub-page chunk (page-habits-detail)', () => {
    for (const name of ['page-goals-abc.js', 'page-habits-detail-abc.js']) {
      const result = run({
        'index.html': html(entry + `<script type="module" src="/assets/${name}"></script>`),
        'assets/index-abc.js': 'console.log(1)',
        [`assets/${name}`]: 'console.log(2)',
      });
      expect(result.status, name).toBe(1);
      expect(result.stderr).toContain(name);
    }
  });

  it('passes with page-home and counts it', () => {
    const home = 'export const home = 1;';
    const result = run({
      'index.html': html(entry + '<link rel="modulepreload" crossorigin href="/assets/page-home-abc.js">'),
      'assets/index-abc.js': 'console.log(1)',
      'assets/page-home-abc.js': home,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('page-home-abc.js');
  });

  it('fails above 81920 bytes gzip', () => {
    const result = run({
      'index.html': html(entry),
      'assets/index-abc.js': noise(82_500),
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('81920');
  });
});

describe('check-budget.mjs counts what the first load really fetches', () => {
  it('follows the imports of the loaded chunks (workbox-window is imported at start-up)', () => {
    const result = run({
      'index.html': html(entry),
      'assets/index-abc.js': 'import("./workbox-def.js");import{a}from"./shared-ghi.js";console.log(a)',
      'assets/workbox-def.js': noise(41_000),
      'assets/shared-ghi.js': noise(41_000),
    });
    expect(result.stdout).toContain('workbox-def.js');
    expect(result.stdout).toContain('shared-ghi.js');
    expect(result.status).toBe(1);
  });

  it('does not count the lazy page chunks the entry imports on navigation', () => {
    const result = run({
      'index.html': html(entry),
      'assets/index-abc.js': 'const p=()=>import(`./page-goals-def.js`);console.log(p)',
      'assets/page-goals-def.js': noise(90_000),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain('page-goals-def.js');
  });

  it('counts a chunk once even when two loaded files import it', () => {
    const result = run({
      'index.html': html(entry + '<link rel="modulepreload" href="/assets/vendor-def.js">'),
      'assets/index-abc.js': 'import"./vendor-def.js";import("./vendor-def.js")',
      'assets/vendor-def.js': 'export const v = 1;',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.match(/vendor-def\.js/g)).toHaveLength(1);
  });

  it('fails clearly when a followed import is missing from dist', () => {
    const result = run({
      'index.html': html(entry),
      'assets/index-abc.js': 'import("./gone-xyz.js")',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('gone-xyz.js');
  });
});

describe('vite.config.ts names each page chunk page-<name>-[hash].js', () => {
  type Namer = (chunk: { name: string; facadeModuleId: string | null; isDynamicEntry: boolean }) => string;
  const output = viteConfig.build?.rolldownOptions?.output;
  const namer = (Array.isArray(output) ? output[0] : output)?.chunkFileNames as Namer | undefined;
  const chunk = (id: string | null, name = 'x') => ({ name, facadeModuleId: id, isDynamicEntry: true });

  it.each([
    ['/w/web/src/pages/habits/index.tsx', 'assets/page-habits-[hash].js'],
    ['/w/web/src/pages/habits/detail.tsx', 'assets/page-habits-detail-[hash].js'],
    ['/w/web/src/pages/habits/editor.tsx', 'assets/page-habits-editor-[hash].js'],
    ['/w/web/src/pages/goals/detail.tsx', 'assets/page-goals-detail-[hash].js'],
    ['C:\\w\\web\\src\\pages\\pair\\index.tsx', 'assets/page-pair-[hash].js'],
  ])('%s becomes %s', (id, name) => {
    expect(typeof namer).toBe('function');
    expect(namer?.(chunk(id))).toBe(name);
  });

  it('leaves other chunks on the default pattern', () => {
    expect(namer?.(chunk('/w/web/src/lib/format.ts'))).toBe('assets/[name]-[hash].js');
    expect(namer?.(chunk(null))).toBe('assets/[name]-[hash].js');
  });
});

describe('app.tsx loads every page but home lazily', () => {
  const app = readFileSync(join(webRoot, 'src/app.tsx'), 'utf8');

  it('imports only the home page statically', () => {
    const staticPages = [...app.matchAll(/^import[^;]*from\s+'(\.\/pages\/[^']+)'/gm)].map((m) => m[1]);
    expect(staticPages).toEqual(['./pages/home']);
  });

  it('loads the other twelve page modules through lazy(() => import(...))', () => {
    const lazyPages = [...app.matchAll(/lazy\(\s*\(\)\s*=>\s*import\('(\.\/pages\/[^']+)'\)\s*\)/g)].map((m) => m[1]);
    expect(lazyPages.sort()).toEqual(
      [
        './pages/ask',
        './pages/breath',
        './pages/day',
        './pages/focus',
        './pages/goals',
        './pages/goals/detail',
        './pages/habits',
        './pages/habits/detail',
        './pages/habits/editor',
        './pages/pair',
        './pages/review',
        './pages/settings',
      ].sort(),
    );
  });

  it('registers every route of design section 3 once', () => {
    const paths = [...app.matchAll(/\bpath="([^"]+)"/g)].map((m) => m[1]);
    expect(paths).toEqual([
      '/',
      '/day',
      '/day/morning',
      '/day/evening',
      '/habits',
      '/habits/new',
      '/habits/:code',
      '/habits/:code/edit',
      '/goals',
      '/goals/:ref',
      '/review',
      '/focus',
      '/breath',
      '/ask',
      '/settings',
      '/pair',
    ]);
  });
});
