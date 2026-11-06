import { defineConfig, devices } from "@playwright/test";
import { ACTIVE_PREFIX_ENV, AI_OFF_SUITES } from "./e2e/support/harness";
import { e2eWebServers, sharedConfig } from "./playwright.config";

/**
 * The AI-OFF e2e run (M12 harness fix, D-186). M4 and M9 were written against an app with no AI
 * provider and assert its honest "AI is not configured" / "AI is not switched on" states, which
 * cannot appear on the main run's server (recorded AI since Q-47, D-182). Their suites run here,
 * selected by title (no spec file moves, no assertion changes), on a production build with
 * AI_PROVIDER unset.
 *
 * The project is named "desktop" because those suites skip any other project. It has its own
 * port, build directory and queue prefix. It shares the `_e2e` database with the main run because
 * `pnpm test:e2e` runs the two configs strictly one after the other, and each run's global setup
 * recreates the database from zero.
 */
const PORT = Number(process.env.E2E_AIOFF_PORT ?? 3101);
export const E2E_AIOFF_QUEUE_PREFIX = "nexaworks-e2e-aioff";
// Overwrites the main config's default (it is imported above, so it ran first).
process.env[ACTIVE_PREFIX_ENV] = E2E_AIOFF_QUEUE_PREFIX;

export default defineConfig({
  ...sharedConfig,
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "desktop",
      grep: AI_OFF_SUITES,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } },
    },
  ],
  webServer: e2eWebServers({
    port: PORT,
    distDir: ".next-e2e-aioff",
    queuePrefix: E2E_AIOFF_QUEUE_PREFIX,
    aiRecordingsDir: null,
  }),
});
