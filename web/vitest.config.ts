import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts so the PWA plugin is not loaded while testing.
export default defineConfig({
  // Vite 8 transforms JSX with Oxc. The automatic runtime with importSource 'preact' makes
  // *.tsx tests compile against preact/jsx-runtime, the same way src/ does via tsconfig.json.
  oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
  test: {
    // Pure logic stays on node. A component test opts in with `// @vitest-environment happy-dom`.
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
    setupFiles: ['tests/setup-dom.ts'],
  },
});
