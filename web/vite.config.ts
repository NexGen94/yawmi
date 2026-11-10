import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

import { pwaOptions } from './pwa.config.ts';

export default defineConfig({
  plugins: [preact(), VitePWA(pwaOptions)],
  server: {
    proxy: {
      // The API serves everything under /v1; in dev it runs on localhost:8000.
      '/v1': 'http://localhost:8000',
    },
  },
});
