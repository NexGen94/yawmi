import { defineConfig, devices } from '@playwright/test';

// The end-to-end suite: the built web app (`vite preview`, port 4173, `/v1` proxied) against the
// local test API (api/tools/e2e_server.py, port 8000) on a throwaway Postgres.
//
// Locally the browser is the installed Edge (PW_CHANNEL=msedge); in CI Chromium is installed by
// the workflow and PW_CHANNEL is unset. Every test pairs its own fresh device in its own browser
// context (e2e/fixtures.ts): there is no global setup and no shared storage state. One worker,
// so the two projects take turns on the one database; each project has its own habits.

const channel = process.env.PW_CHANNEL || undefined;
const inCI = Boolean(process.env.CI);

export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.spec.ts',
  workers: 1,
  fullyParallel: false,
  forbidOnly: inCI,
  retries: 0,
  reporter: inCI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  outputDir: 'test-results',
  use: {
    baseURL: 'http://localhost:4173',
    locale: 'ar-SA',
    timezoneId: 'Asia/Riyadh',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], channel, viewport: { width: 1280, height: 800 } },
    },
    {
      name: 'mobile',
      use: { ...devices['Desktop Chrome'], channel, viewport: { width: 390, height: 844 } },
    },
  ],
  webServer: [
    {
      // Resets the database it is pointed at (YAWMI_E2E_DATABASE_URL, a local one) and seeds it.
      // --no-sync: run in the environment that `uv sync` made (CI installs it without Web Push).
      command: 'uv run --no-sync python tools/e2e_server.py --port 8000',
      cwd: '../api',
      url: 'http://127.0.0.1:8000/v1/health/live',
      reuseExistingServer: !inCI,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'npm run build && npx vite preview --port 4173 --strictPort',
      url: 'http://localhost:4173',
      reuseExistingServer: !inCI,
      timeout: 240_000,
    },
  ],
});
