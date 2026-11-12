import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

import { pwaOptions } from './pwa.config.ts';

/** src/pages/<name>/index.tsx -> page-<name>, src/pages/<name>/<file>.tsx -> page-<name>-<file>. */
const PAGE = /[\\/]src[\\/]pages[\\/]([\w-]+)[\\/]([\w-]+)\.tsx$/;
const NON_HOME_PAGE = /[\\/]src[\\/]pages[\\/](?!home(?:[\\/]|$))[\w-]+/;

function firstLoadPagesPlugin() {
  return {
    name: 'first-load-pages',
    generateBundle(_options: unknown, bundle: Record<string, unknown>) {
      const chunks = new Map<string, { fileName: string; isEntry?: boolean; imports?: string[]; moduleIds?: string[] }>();
      for (const item of Object.values(bundle)) {
        if (item && typeof item === 'object' && (item as { type?: string }).type === 'chunk') {
          const chunk = item as { fileName: string; isEntry?: boolean; imports?: string[]; moduleIds?: string[] };
          chunks.set(chunk.fileName, chunk);
        }
      }
      const visited = new Set<string>();
      const queue = [...chunks.values()].filter((c) => c.isEntry).map((c) => c.fileName);
      const leaked: string[] = [];
      while (queue.length > 0) {
        const name = queue.shift()!;
        if (visited.has(name)) continue;
        visited.add(name);
        const chunk = chunks.get(name);
        if (!chunk) continue;
        for (const id of chunk.moduleIds ?? []) {
          if (NON_HOME_PAGE.test(id)) leaked.push(`${name}: ${id}`);
        }
        for (const imp of chunk.imports ?? []) {
          if (!visited.has(imp)) queue.push(imp);
        }
      }
      if (leaked.length > 0) {
        throw new Error(`First-load chunk bundles non-home page module: ${leaked.join(', ')}`);
      }
    },
  };
}

export default defineConfig({
  plugins: [preact(), firstLoadPagesPlugin(), VitePWA(pwaOptions)],
  build: {
    rolldownOptions: {
      output: {
        // Every lazy page gets a recognizable chunk name, so scripts/check-budget.mjs can refuse
        // any page but home in what index.html loads first.
        chunkFileNames: (chunk) => {
          const match = PAGE.exec(chunk.facadeModuleId ?? '');
          if (!match) return 'assets/[name]-[hash].js';
          const [, dir, file] = match;
          const suffix = file === 'index' ? '' : '-' + file;
          return `assets/page-${dir}${suffix}-[hash].js`;
        },
      },
    },
  },
  server: {
    proxy: {
      // The API serves everything under /v1; in dev it runs on localhost:8000.
      '/v1': 'http://localhost:8000',
    },
  },
});
