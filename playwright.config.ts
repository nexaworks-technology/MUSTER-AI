import { defineConfig, devices } from "@playwright/test";
import { applyTestDatabaseEnv } from "./src/test/db-env";

/**
 * e2e runs the app against the `_test` database (seeded in global-setup). It uses `next dev`
 * because the production server refuses the log-only email transport, which the invitation
 * test reads from `.dev-mail/`. Stop any other `next dev` in this folder first.
 */
applyTestDatabaseEnv();
const PORT = Number(process.env.E2E_PORT ?? 3100);

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
  webServer: {
    command: `pnpm exec next dev -p ${PORT}`,
    url: `http://localhost:${PORT}/sign-in`,
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      DATABASE_URL: process.env.DATABASE_URL!,
      DATABASE_URL_MIGRATE: process.env.DATABASE_URL_MIGRATE!,
      APP_URL: `http://localhost:${PORT}`,
      EMAIL_TRANSPORT: "log",
    },
  },
});
