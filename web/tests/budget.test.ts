import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
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

  it('fails for any page- chunk in index.html, including page-home (home is eager and inlined, never a chunk)', () => {
    const result = run({
      'index.html': html(entry + '<link rel="modulepreload" crossorigin href="/assets/page-home-abc.js">'),
      'assets/index-abc.js': 'console.log(1)',
      'assets/page-home-abc.js': 'export const home = 1;',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('page-home-abc.js');
  });

  it('fails when the static module graph from src/main.tsx reaches a non-home page (plants A, B, C)', () => {
    const root = mkdtempSync(join(tmpdir(), 'yawmi-budget-graph-'));
    made.push(root);
    mkdirSync(join(root, 'dist/assets'), { recursive: true });
    mkdirSync(join(root, 'src/pages/home'), { recursive: true });
    mkdirSync(join(root, 'src/pages/goals'), { recursive: true });
    writeFileSync(join(root, 'dist/index.html'), html(entry));
    writeFileSync(join(root, 'dist/assets/index-abc.js'), 'console.log(1)');
    writeFileSync(join(root, 'src/main.tsx'), "import './pages/home';\n");
    writeFileSync(join(root, 'src/pages/home/index.tsx'), "import '../goals';\nexport default function Home() { return null; }\n");
    writeFileSync(join(root, 'src/pages/goals/index.tsx'), 'export default function Goals() { return null; }\n');

    const result = spawnSync(process.execPath, [script, '--dist', join(root, 'dist')], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('pages/goals');
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

  it('counts and fails on a static import of a page chunk from the entry chunk (plant D)', () => {
    const result = run({
      'index.html': html(entry),
      'assets/index-abc.js': 'import{a}from"./page-habits-abc.js";console.log(a)',
      'assets/page-habits-abc.js': noise(90_000),
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('page-habits-abc.js');
    expect(result.stderr).toContain('page-habits-abc.js');
    expect(result.stderr).toContain('81920');
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

  it('fails generateBundle when an entry or statically imported chunk contains a non-home page module', () => {
    const plugins = (viteConfig.plugins ?? []).flat();
    const guard = plugins.find(
      (p): p is { name: string; generateBundle: (opts: unknown, bundle: Record<string, unknown>) => void } =>
        Boolean(p && typeof p === 'object' && 'name' in p && p.name === 'first-load-pages'),
    );
    expect(guard).toBeDefined();

    // Clean bundle: entry has home, lazy chunk has goals.
    expect(() =>
      guard?.generateBundle(
        {},
        {
          'assets/index-abc.js': {
            type: 'chunk',
            fileName: 'assets/index-abc.js',
            isEntry: true,
            imports: [],
            moduleIds: ['/w/web/src/main.tsx', '/w/web/src/pages/home/index.tsx'],
          },
          'assets/page-goals-def.js': {
            type: 'chunk',
            fileName: 'assets/page-goals-def.js',
            isEntry: false,
            imports: [],
            moduleIds: ['/w/web/src/pages/goals/index.tsx'],
          },
        },
      ),
    ).not.toThrow();

    // Plant B: home statically imported goals, so Rolldown inlined goals into the entry chunk.
    expect(() =>
      guard?.generateBundle(
        {},
        {
          'assets/index-abc.js': {
            type: 'chunk',
            fileName: 'assets/index-abc.js',
            isEntry: true,
            imports: [],
            moduleIds: ['/w/web/src/main.tsx', '/w/web/src/pages/home/index.tsx', '/w/web/src/pages/goals/index.tsx'],
          },
        },
      ),
    ).toThrow(/pages[\\/]goals/);

    // Static import chain: entry statically imports a shared chunk that bundles a non-home page.
    expect(() =>
      guard?.generateBundle(
        {},
        {
          'assets/index-abc.js': {
            type: 'chunk',
            fileName: 'assets/index-abc.js',
            isEntry: true,
            imports: ['assets/shared-xyz.js'],
            moduleIds: ['/w/web/src/main.tsx', '/w/web/src/pages/home/index.tsx'],
          },
          'assets/shared-xyz.js': {
            type: 'chunk',
            fileName: 'assets/shared-xyz.js',
            isEntry: false,
            imports: [],
            moduleIds: ['/w/web/src/pages/review/index.tsx'],
          },
        },
      ),
    ).toThrow(/pages[\\/]review/);
  });
});

describe('app.tsx loads every page but home lazily', () => {
  const app = readFileSync(join(webRoot, 'src/app.tsx'), 'utf8');

  it('imports only the home page statically', () => {
    const staticPages = [...app.matchAll(/^import[^;]*from\s+'(\.\/pages\/[^']+)'/gm)].map((m) => m[1]);
    expect(staticPages).toEqual(['./pages/home']);
  });

  it('reaches only modules of src/pages/home/ (and its index.tsx) across the entire static import graph from src/main.tsx', () => {
    const staticImport =
      /(?:^|[\r\n;])\s*(?:import|export)\b(?:(?!\btype\b)[^;\r\n])*?\bfrom\s*(['"])(\.{1,2}\/[^'"]+)\1|(?:^|[\r\n;])\s*import\s*(['"])(\.{1,2}\/[^'"]+)\3/g;
    const resolveModule = (fromFile: string, spec: string): string | null => {
      const base = resolve(dirname(fromFile), spec);
      for (const suffix of ['', '.ts', '.tsx', '/index.ts', '/index.tsx']) {
        const candidate = base + suffix;
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
      }
      return null;
    };
    const seen = new Set<string>();
    const queue = [join(webRoot, 'src/main.tsx')];
    const pages: string[] = [];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (seen.has(current)) continue;
      seen.add(current);
      const rel = relative(webRoot, current).replaceAll('\\', '/');
      if (rel.startsWith('src/pages/')) pages.push(rel);
      for (const match of readFileSync(current, 'utf8').matchAll(staticImport)) {
        const spec = match[2] ?? match[4];
        if (!spec) continue;
        const target = resolveModule(current, spec);
        if (target && !seen.has(target)) queue.push(target);
      }
    }
    // The home page is eager and may have files of its own (the page task splits it into components);
    // every other page folder stays out of the first load.
    expect(pages).toContain('src/pages/home/index.tsx');
    expect(pages.filter((page) => !page.startsWith('src/pages/home/'))).toEqual([]);
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
