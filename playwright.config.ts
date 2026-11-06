import { defineConfig, devices } from "@playwright/test";
import { applyE2eDatabaseEnv } from "./src/test/db-env";

/**
 * e2e runs the PRODUCTION BUILD (M12 B7; D-37 retired, D-182): `next build` into `.next-e2e`, then
 * `next start`, with APP_ENV=e2e against its own `_e2e` database (recreated from zero in
 * global-setup, D4). Only that combination unlocks the test seams below in a production build
 * (fake clock, recorded AI, log email/Slack, fixture integrations); staging and production refuse
 * them. The strict production CSP is therefore the one the browser checks. Stop any other
 * `next dev`/`next start` on the e2e port first.
 */
applyE2eDatabaseEnv();
const PORT = Number(process.env.E2E_PORT ?? 3100);
// The app (production build) and the worker must share one queue prefix,
// distinct from dev's, so a running dev worker can never take e2e jobs.
export const E2E_QUEUE_PREFIX = "nexaworks-e2e";
// The e2e world is frozen at the seed's day (SEED_TODAY 2026-11-02): both servers read business
// "today" from this instant, midday Nov 2 in America/New_York (Q-49, D-81). Test-only flags,
// ignored in production.
const E2E_FAKE_CLOCK = { ALLOW_FAKE_CLOCK: "true", APP_FAKE_NOW: "2026-11-02T17:00:00Z" };
// M5 (D-85, founder D5): connectors run on recorded fixtures; any unrecorded request fails.
const E2E_INTEGRATIONS = { INTEGRATIONS_TRANSPORT: "fixture" };
// Recorded model answers the app server replays (composed by the specs' prepare scripts).
export const E2E_RECORDINGS = ".dev-recordings/e2e-app";

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
      command: `pnpm exec next build && pnpm exec next start -p ${PORT}`,
      url: `http://localhost:${PORT}/sign-in`,
      reuseExistingServer: false,
      timeout: 600_000,
      env: {
        DATABASE_URL: process.env.DATABASE_URL!,
        DATABASE_URL_MIGRATE: process.env.DATABASE_URL_MIGRATE!,
        APP_URL: `http://localhost:${PORT}`,
        NODE_ENV: "production", // db-env sets "test" for this process; the server is a production build
        APP_ENV: "e2e",
        // The whole suite signs in from ::1; the real limits are proven by endpoints-m12 (D-182).
        RATE_LIMIT_SCALE: "50",
        NEXT_DIST_DIR: ".next-e2e",
        EMAIL_TRANSPORT: "log",
        SLACK_DELIVERY: "log",
        // Q-47 closed (D7): the app server runs on recorded answers, so in-app AI paths are e2e-tested.
        AI_PROVIDER: "recorded",
        AI_RECORDINGS_DIR: E2E_RECORDINGS,
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
