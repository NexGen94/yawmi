import { resolve } from 'node:path';
import { build } from 'vite';
import { beforeAll, describe, expect, it } from 'vitest';

// The modules that only lazy pages share (the dialog, the fields, the switch, the chips, the
// slider, the disclosure) used to be one tiny chunk each: a page that needs five of them fetched
// five files, and any of them could end up beside the first load. They are one named chunk now
// (vite.config.ts), and the first load must never import it (Task 21: +887 B, Task 24).

const webRoot = resolve(import.meta.dirname, '..');
const BS = String.fromCharCode(92);
const norm = (path: string): string => path.split(BS).join('/');

interface Chunk {
  fileName: string;
  isEntry: boolean;
  imports: string[];
  moduleIds: string[];
}

let chunks: Chunk[] = [];

beforeAll(async () => {
  await build({
    root: webRoot,
    configFile: resolve(webRoot, 'vite.config.ts'),
    logLevel: 'silent',
    build: { outDir: resolve(webRoot, 'node_modules', '.cache', 'chunks-test'), emptyOutDir: true, write: false },
    plugins: [
      {
        name: 'collect-chunks',
        generateBundle(_options: unknown, bundle: Record<string, { type: string } & Partial<Chunk>>) {
          chunks = Object.values(bundle)
            .filter((item) => item.type === 'chunk')
            .map((item) => ({
              fileName: item.fileName as string,
              isEntry: Boolean(item.isEntry),
              imports: item.imports ?? [],
              moduleIds: (item.moduleIds ?? []).map(norm),
            }));
        },
      },
    ],
  });
}, 120_000);

const LAZY_UI = ['Chips', 'Dialog', 'Disclosure', 'Field', 'Segmented', 'Slider'];

function firstLoad(): Set<string> {
  const byName = new Map(chunks.map((c) => [c.fileName, c]));
  const seen = new Set<string>();
  const queue = chunks.filter((c) => c.isEntry).map((c) => c.fileName);
  while (queue.length > 0) {
    const name = queue.shift() as string;
    if (seen.has(name)) continue;
    seen.add(name);
    queue.push(...(byName.get(name)?.imports ?? []));
  }
  return seen;
}

describe('the chunk of the modules that only lazy pages share', () => {
  it('holds the six UI primitives that no first-load module imports, in one file', () => {
    const shared = chunks.filter((c) => /\/lazy-ui-[\w-]+\.js$/.test(`/${c.fileName}`));
    expect(shared, 'a chunk named lazy-ui-<hash>.js').toHaveLength(1);
    for (const name of LAZY_UI) {
      expect(
        shared[0]?.moduleIds.some((id) => id.endsWith(`/src/ui/${name}.tsx`)),
        `${name} is in the lazy-ui chunk`,
      ).toBe(true);
      const alone = chunks.filter((c) => c.moduleIds.some((id) => id.endsWith(`/src/ui/${name}.tsx`)));
      expect(alone.map((c) => c.fileName), `${name} is in one chunk only`).toHaveLength(1);
    }
  });

  it('takes nothing with it from the first load: only the UI primitives themselves are in it', () => {
    const shared = chunks.find((c) => /\/lazy-ui-[\w-]+\.js$/.test(`/${c.fileName}`));
    expect(shared).toBeDefined();
    const sources = (shared?.moduleIds ?? []).filter((id) => id.includes('/src/'));
    expect(sources.every((id) => /\/src\/ui\/(Chips|Dialog|Disclosure|Field|Segmented|Slider|direction)\.tsx?$/.test(id)), sources.join(', ')).toBe(true);
  });

  it('is not part of the first load', () => {
    const shared = chunks.find((c) => /\/lazy-ui-[\w-]+\.js$/.test(`/${c.fileName}`));
    expect(shared).toBeDefined();
    expect(firstLoad().has(shared?.fileName as string)).toBe(false);
  });
});
