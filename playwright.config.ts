import { defineConfig, devices } from "@playwright/test";
import { applyTestDatabaseEnv } from "./src/test/db-env";

/**
 * e2e runs the app against the `_test` database (seeded in global-setup). It uses `next dev`
 * because the production server refuses the log-only email transport, which the invitation
 * test reads from `.dev-mail/`. Stop any other `next dev` in this folder first.
 */
applyTestDatabaseEnv();
const PORT = Number(process.env.E2E_PORT ?? 3100);
// The app (`next dev`, always NODE_ENV=development) and the worker must share one queue prefix,
// distinct from dev's, so a running dev worker can never take e2e jobs.
const E2E_QUEUE_PREFIX = "nexaworks-e2e";
// The e2e world is frozen at the seed's day (SEED_TODAY 2026-11-02): both servers read business
// "today" from this instant, midday Nov 2 in America/New_York (Q-49, D-81). Test-only flags,
// ignored in production.
const E2E_FAKE_CLOCK = { ALLOW_FAKE_CLOCK: "true", APP_FAKE_NOW: "2026-11-02T17:00:00Z" };
// M5 (D-85, founder D5): connectors run on recorded fixtures; any unrecorded request fails.
const E2E_INTEGRATIONS = { INTEGRATIONS_TRANSPORT: "fixture" };

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } },
    },
    {
      name: "mobile",
      use: { ...devices["Desktop Chrome"], viewport: { width: 375, height: 812 } },
    },
  ],
  webServer: [
    {
      command: `pnpm exec next dev -p ${PORT}`,
      url: `http://localhost:${PORT}/sign-in`,
      reuseExistingServer: false,
      timeout: 180_000,
      env: {
        DATABASE_URL: process.env.DATABASE_URL!,
        DATABASE_URL_MIGRATE: process.env.DATABASE_URL_MIGRATE!,
        APP_URL: `http://localhost:${PORT}`,
        EMAIL_TRANSPORT: "log",
        QUEUE_PREFIX: E2E_QUEUE_PREFIX,
        ...E2E_FAKE_CLOCK,
        ...E2E_INTEGRATIONS,
      },
    },
    // CSV imports run on the worker (D-47), so e2e starts it too, against the same database.
    {
      command: "pnpm exec tsx src/worker/index.ts",
      wait: { stdout: /worker started/ },
      stdout: "pipe",
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        DATABASE_URL: process.env.DATABASE_URL!,
        DATABASE_URL_MIGRATE: process.env.DATABASE_URL_MIGRATE!,
        QUEUE_PREFIX: E2E_QUEUE_PREFIX,
        // No real-clock nightly runs against the seeded workspace, which stays "as of" SEED_TODAY.
        NIGHTLY_SCHEDULES: "off",
        ...E2E_FAKE_CLOCK,
        ...E2E_INTEGRATIONS,
      },
    },
  ],
});
