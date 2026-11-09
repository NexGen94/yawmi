import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts so the PWA plugin is not loaded while testing.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
