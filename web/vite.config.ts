import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

import { pwaOptions } from './pwa.config.ts';

/** src/pages/<name>/index.tsx -> page-<name>, src/pages/<name>/<file>.tsx -> page-<name>-<file>. */
const PAGE = /[\\/]src[\\/]pages[\\/]([\w-]+)[\\/]([\w-]+)\.tsx$/;

export default defineConfig({
  plugins: [preact(), VitePWA(pwaOptions)],
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
