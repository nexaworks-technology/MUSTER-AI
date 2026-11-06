import { defineConfig, devices, type PlaywrightTestConfig } from "@playwright/test";
import { ACTIVE_PREFIX_ENV, AI_OFF_SUITES } from "./e2e/support/harness";
import { applyE2eDatabaseEnv } from "./src/test/db-env";

/**
 * e2e runs the PRODUCTION BUILD (M12 B7; D-37 retired, D-182): `next build` into `.next-e2e`, then
 * `next start`, with APP_ENV=e2e against its own `_e2e` database (recreated from zero in
 * global-setup, D4). Only that combination unlocks the test seams below in a production build
 * (fake clock, recorded AI, log email/Slack, fixture integrations); staging and production refuse
 * them. The strict production CSP is therefore the one the browser checks.
 *
 * This is the MAIN run: the app server replays recorded AI answers. Suites written for an app with
 * no AI provider run in `playwright.aioff.config.ts` instead (D-186); `pnpm test:e2e` runs both,
 * one after the other. Stop any `pnpm dev` in this folder first.
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

export interface HarnessOptions {
  port: number;
  /** Production build output directory for this run. */
  distDir: string;
  /** Queue prefix shared by this run's app server and worker. */
  queuePrefix: string;
  /** Recorded AI answers for the app server, or null for an app with no AI provider. */
  aiRecordingsDir: string | null;
}

/** The production-build app server and the worker for one e2e run (shared with the AI-off run). */
export function e2eWebServers(o: HarnessOptions): NonNullable<PlaywrightTestConfig["webServer"]> {
  // Q-47 closed (D7): the main app server runs on recorded answers, so in-app AI paths are
  // e2e-tested. The AI-off run has no provider key, so the app shows "AI is not configured" (D-186).
  // e2e never reaches a live model: the developer's .env key is blanked for every e2e process
  // (Next would otherwise load it from .env, and the runner already has it). D-186.
  const ai: Record<string, string> = o.aiRecordingsDir
    ? { AI_PROVIDER: "recorded", AI_RECORDINGS_DIR: o.aiRecordingsDir, ANTHROPIC_API_KEY: "" }
    : { AI_PROVIDER: "anthropic", AI_RECORDINGS_DIR: "", ANTHROPIC_API_KEY: "" };
  return [
    {
      command: `pnpm exec next build && pnpm exec next start -p ${o.port}`,
      url: `http://localhost:${o.port}/sign-in`,
      reuseExistingServer: false,
      timeout: 600_000,
      env: {
        DATABASE_URL: process.env.DATABASE_URL!,
        DATABASE_URL_MIGRATE: process.env.DATABASE_URL_MIGRATE!,
        APP_URL: `http://localhost:${o.port}`,
        NODE_ENV: "production", // the Playwright runner sets "test"; the server is a production build
        APP_ENV: "e2e",
        // The whole suite signs in from ::1; the real limits are proven by endpoints-m12 (D-182).
        RATE_LIMIT_SCALE: "50",
        NEXT_DIST_DIR: o.distDir,
        EMAIL_TRANSPORT: "log",
        SLACK_DELIVERY: "log",
        ...ai,
        QUEUE_PREFIX: o.queuePrefix,
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
        QUEUE_PREFIX: o.queuePrefix,
        ANTHROPIC_API_KEY: "", // never a live model in e2e (D-186)
        // No real-clock nightly runs against the seeded workspace, which stays "as of" SEED_TODAY.
        NIGHTLY_SCHEDULES: "off",
        ...E2E_FAKE_CLOCK,
        ...E2E_INTEGRATIONS,
      },
    },
  ];
}

/** Settings both runs share; each config adds its projects and servers. */
export const sharedConfig: PlaywrightTestConfig = {
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: [["list"]],
};

process.env[ACTIVE_PREFIX_ENV] ??= E2E_QUEUE_PREFIX;

export default defineConfig({
  ...sharedConfig,
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "desktop",
      grepInvert: AI_OFF_SUITES,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } },
    },
    {
      name: "mobile",
      grepInvert: AI_OFF_SUITES,
      use: { ...devices["Desktop Chrome"], viewport: { width: 375, height: 812 } },
    },
  ],
  webServer: e2eWebServers({
    port: PORT,
    distDir: ".next-e2e",
    queuePrefix: E2E_QUEUE_PREFIX,
    aiRecordingsDir: E2E_RECORDINGS,
  }),
});
