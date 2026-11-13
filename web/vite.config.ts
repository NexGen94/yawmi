import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

import { PORTS } from './e2e/ports.ts';
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
        // The UI primitives that only lazy pages use were one tiny chunk each (a page needing five
        // fetched five files). One named group puts them in a single chunk that the first load never
        // imports (tests/chunks.test.ts). The group takes the matched modules alone
        // (`includeDependenciesRecursively: false`): what they import, `ui/layer.ts` for one, stays
        // where the first load needs it.
        codeSplitting: {
          groups: [
            {
              name: 'lazy-ui',
              test: /[\\/]src[\\/]ui[\\/](?:Chips|Dialog|Disclosure|Field|Segmented|Slider|direction)\.tsx?$/,
              includeDependenciesRecursively: false,
              priority: 10,
            },
          ],
        },
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
      // The API serves everything under /v1; in dev it runs on localhost:8000 (YAWMI_API_PORT).
      '/v1': `http://localhost:${PORTS.api}`,
    },
  },
  preview: {
    proxy: {
      // The end-to-end suite (web/e2e) serves the build with `vite preview` and a local API on
      // YAWMI_API_PORT (8000 by default). By address, not by name: the test server listens on IPv4 loopback only, and a
      // proxy that resolves `localhost` to ::1 would be refused.
      '/v1': `http://127.0.0.1:${PORTS.api}`,
    },
  },
});
