import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import { manifest, pwaOptions } from '../pwa.config';
import viteConfig from '../vite.config';

const webRoot = resolve(import.meta.dirname, '..');
const repoRoot = resolve(webRoot, '..');
const read = (path: string): string => readFileSync(join(webRoot, path), 'utf8');

// The shell is technical plumbing only: no visual design is approved yet (D-061), so the
// checks below cover the manifest, the document head, the service worker and the budget.

describe('web app manifest', () => {
  it('declares identity, language, direction and scope', () => {
    expect(manifest).toMatchObject({
      id: '/',
      name: 'يومي',
      short_name: 'يومي',
      lang: 'ar',
      dir: 'rtl',
      start_url: '/',
      scope: '/',
      display: 'standalone',
    });
  });

  it('has theme and background colors as placeholders', () => {
    expect(manifest.theme_color).toBe('#ffffff');
    expect(manifest.background_color).toBe('#ffffff');
  });

  it('has 192 and 512 icons, one of the 512 ones maskable', () => {
    const icons = manifest.icons ?? [];
    const sizes = icons.map((icon) => icon.sizes);
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');
    const maskable = icons.filter((icon) => (icon.purpose ?? '').split(/\s+/).includes('maskable'));
    expect(maskable).toHaveLength(1);
    expect(maskable[0]?.sizes).toBe('512x512');
  });

  it('points every icon at a file that exists in public/', () => {
    for (const icon of manifest.icons ?? []) {
      expect(existsSync(join(webRoot, 'public', icon.src)), icon.src).toBe(true);
    }
    expect(existsSync(join(webRoot, 'public/apple-touch-icon-180x180.png'))).toBe(true);
  });
});

describe('index.html', () => {
  const html = read('index.html');

  it('is Arabic and right-to-left', () => {
    expect(html).toMatch(/<html[^>]*\slang="ar"/);
    expect(html).toMatch(/<html[^>]*\sdir="rtl"/);
  });

  it('uses the full screen on notched devices', () => {
    expect(html).toMatch(/<meta[^>]*name="viewport"[^>]*viewport-fit=cover/);
  });

  it('carries the three Apple web app tags', () => {
    expect(html).toMatch(/<meta[^>]*name="apple-mobile-web-app-capable"[^>]*content="yes"/);
    expect(html).toMatch(/<meta[^>]*name="apple-mobile-web-app-status-bar-style"[^>]*content="black-translucent"/);
    expect(html).toMatch(/<meta[^>]*name="apple-mobile-web-app-title"[^>]*content="يومي"/);
  });

  it('links the 180px apple-touch-icon', () => {
    expect(html).toMatch(/<link[^>]*rel="apple-touch-icon"[^>]*href="\/apple-touch-icon-180x180\.png"/);
  });
});

describe('vite + pwa config', () => {
  it('uses a prompt-style injectManifest service worker (updates are never silent)', () => {
    expect(pwaOptions).toMatchObject({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'prompt',
    });
  });

  it('proxies /v1 to the local API in dev', () => {
    const proxy = viteConfig.server?.proxy;
    expect(proxy?.['/v1']).toBe('http://localhost:8000');
  });

  it('pins Node 24', () => {
    expect(read('.nvmrc').trim()).toBe('24');
  });

  it('pins exact dependency versions (no ranges)', () => {
    const pkg = JSON.parse(read('package.json')) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
      overrides?: Record<string, Record<string, string>>;
    };
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const [name, version] of Object.entries(all)) {
      // An npm alias (`npm:typescript@5.9.3`, see scripts/ts5-for-openapi.mjs) is pinned the same way.
      expect(version, name).toMatch(/^(npm:(@[a-z0-9-]+\/)?[a-z0-9.-]+@)?\d+\.\d+\.\d+$/);
    }
    // Overrides may only point at an exact version or at a pinned root dependency (`$name`).
    for (const [parent, inner] of Object.entries(pkg.overrides ?? {})) {
      for (const [name, version] of Object.entries(inner)) {
        expect(version, `${parent} > ${name}`).toMatch(/^(\d+\.\d+\.\d+|\$[a-z0-9-]+)$/);
        if (version.startsWith('$')) expect(all[version.slice(1)], version).toMatch(/^\d+\.\d+\.\d+$/);
      }
    }
  });
});

describe('service worker source', () => {
  const sw = read('src/sw.ts');

  it('precaches the build manifest and cleans old caches', () => {
    expect(sw).toContain('precacheAndRoute(self.__WB_MANIFEST)');
    expect(sw).toContain('cleanupOutdatedCaches()');
  });

  it('routes navigations to the precached index.html but never /v1', () => {
    expect(sw).toContain('NavigationRoute');
    expect(sw).toContain("createHandlerBoundToURL('index.html')");
    expect(sw).toMatch(/denylist:\s*\[\s*\/\^\\\/v1\\\//);
  });

  it('does not cache API calls: no runtime caching strategy at all', () => {
    expect(sw).not.toMatch(/CacheFirst|NetworkFirst|StaleWhileRevalidate|CacheOnly|workbox-strategies/);
    // Nothing but the navigation route is registered.
    expect(sw.match(/registerRoute\(/g)).toHaveLength(1);
  });

  it('applies a waiting worker only on a SKIP_WAITING message', () => {
    expect(sw).toMatch(/type\s*===\s*'SKIP_WAITING'/);
    expect(sw).toContain('skipWaiting()');
    // Never skips waiting unconditionally, so an update waits for the prompt.
    expect(sw.match(/skipWaiting\(\)/g)).toHaveLength(1);
  });
});

// Physical-direction CSS breaks RTL. The detector is tested on its own so that a regression in
// the regular expression cannot silently let physical properties through.
const physicalCss =
  /(?:^|[\s;{])(?:left|right)\s*:|(?<![\w-])(?:margin|padding|border|inset|scroll-margin|scroll-padding)-(?:left|right)\b|border-(?:top|bottom)-(?:left|right)-radius|(?:float|clear|text-align)\s*:\s*(?:left|right)\b/im;

function stylesheets(): string[] {
  const dir = join(webRoot, 'src/styles');
  return readdirSync(dir)
    .filter((file) => file.endsWith('.css'))
    .map((file) => readFileSync(join(dir, file), 'utf8'));
}

describe('logical CSS only', () => {
  it('the detector catches physical properties', () => {
    for (const bad of [
      'a { left: 0 }',
      'a{right:0}',
      'a { margin-left: 1px }',
      'a { padding-right: 1px }',
      'a { border-left: 1px solid }',
      'a { text-align: left }',
      'a { float: right }',
      'a { border-top-left-radius: 4px }',
      'a { scroll-margin-left: 4px }',
      'a { inset-right: 4px }',
    ]) {
      expect(bad, bad).toMatch(physicalCss);
    }
    for (const good of [
      'a { inset-inline-start: 0 }',
      'a { margin-inline-start: 1px }',
      'a { padding-inline-end: 1px }',
      'a { border-inline-start: 1px solid }',
      'a { text-align: start }',
      'a { border-start-start-radius: 4px }',
      'a { padding-inline: max(env(safe-area-inset-left), env(safe-area-inset-right)) }',
    ]) {
      expect(good, good).not.toMatch(physicalCss);
    }
  });

  it('src/styles has no physical left/right properties', () => {
    const files = stylesheets();
    expect(files.length).toBeGreaterThan(0);
    for (const css of files) {
      expect(css).not.toMatch(physicalCss);
    }
  });

  it('base.css keeps the plumbing-only rules (dvh, safe areas, system-ui)', () => {
    const css = read('src/styles/base.css');
    expect(css).toContain('min-height: 100dvh');
    expect(css).toContain('env(safe-area-inset-top)');
    expect(css).toContain('env(safe-area-inset-bottom)');
    expect(css).toContain('env(safe-area-inset-left)');
    expect(css).toContain('env(safe-area-inset-right)');
    expect(css).toMatch(/font-family:\s*system-ui/);
  });
});

describe('check-budget.mjs', () => {
  const script = join(webRoot, 'scripts/check-budget.mjs');

  function run(files: Record<string, string | Buffer>) {
    const dist = mkdtempSync(join(tmpdir(), 'yawmi-dist-'));
    mkdirSync(join(dist, 'assets'));
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dist, name), content);
    }
    return spawnSync(process.execPath, [script, '--dist', dist], { encoding: 'utf8' });
  }

  const index = (scripts: string, extra = ''): string =>
    `<!doctype html><html><head>${extra}${scripts}</head><body></body></html>`;

  // Random bytes do not compress, so the gzip size tracks the input size.
  const noise = (bytes: number): Buffer =>
    Buffer.from(Array.from({ length: bytes }, () => Math.floor(Math.random() * 256)));

  it('passes and prints the size when the referenced JS is under budget', () => {
    const js = 'console.log("hello");';
    const result = run({
      'index.html': index('<script type="module" crossorigin src="/assets/index-abc.js"></script>'),
      'assets/index-abc.js': js,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`${gzipSync(js).length} / 81920`);
  });

  it('fails when the referenced JS is over budget', () => {
    const result = run({
      'index.html': index('<script type="module" src="/assets/index-abc.js"></script>'),
      'assets/index-abc.js': noise(90_000),
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('81920');
  });

  it('counts modulepreload chunks as well as script tags', () => {
    const result = run({
      'index.html': index(
        '<script type="module" src="/assets/index-abc.js"></script>',
        '<link rel="modulepreload" crossorigin href="/assets/vendor-def.js">',
      ),
      'assets/index-abc.js': noise(45_000),
      'assets/vendor-def.js': noise(45_000),
    });
    expect(result.status).toBe(1);
  });

  it('ignores JS that index.html does not reference (for example sw.js)', () => {
    const result = run({
      'index.html': index('<script type="module" src="/assets/index-abc.js"></script>'),
      'assets/index-abc.js': 'console.log(1)',
      'sw.js': noise(200_000),
    });
    expect(result.status).toBe(0);
  });

  it('fails clearly when index.html is missing', () => {
    const dist = mkdtempSync(join(tmpdir(), 'yawmi-dist-'));
    const result = spawnSync(process.execPath, [script, '--dist', dist], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('index.html');
  });
});

describe('web-tests workflow', () => {
  const workflow = readFileSync(join(repoRoot, '.github/workflows/web-tests.yml'), 'utf8');

  it('pins every action to a full commit SHA', () => {
    const uses = [...workflow.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((m) => m[1] ?? '');
    expect(uses.length).toBeGreaterThan(0);
    for (const ref of uses) {
      expect(ref, ref).toMatch(/@[0-9a-f]{40}$/);
    }
  });

  it('runs on web/** changes and uses the pinned Node version file', () => {
    expect(workflow).toContain('"web/**"');
    expect(workflow).toContain('node-version-file: web/.nvmrc');
  });

  it('typechecks, tests, builds and checks the budget', () => {
    for (const step of [
      'npm ci',
      'npm run typecheck',
      'npx vitest run',
      'npm run build',
      'node scripts/check-budget.mjs',
    ]) {
      expect(workflow, step).toContain(step);
    }
  });
});
