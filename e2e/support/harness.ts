/**
 * e2e harness constants shared by the two Playwright configs (M12 harness fix, D-186):
 *
 * - `playwright.config.ts`: the main run. The app server replays recorded AI answers (Q-47, D-182).
 *   It also builds both runs' servers (`e2eWebServers`).
 * - `playwright.aioff.config.ts`: the AI-off run, for the suites written against an app with no AI
 *   provider (they assert the honest "AI is not configured" states). Routed by suite title, so no
 *   spec file moves and no assertion changes.
 *
 * `scripts/e2e.ts` (`pnpm test:e2e`) runs the two configs one after the other, never at once. Each
 * run's global setup recreates the same `_e2e` database from zero, so sharing it is safe.
 */

/** Suites whose assertions need an app with no AI provider (M4 and M9 were written that way). */
export const AI_OFF_SUITES =
  /M4 Today, approvals and the AI team|M9 Conversations, Inbox, Promises & Sentiment/;

/**
 * Scripts that specs spawn (`runScript`) run their own in-process workers on THIS prefix, where no
 * long-running worker listens. On the app's prefix the e2e worker (AI off by design) took their
 * jobs and failed them `NOT_CONFIGURED`, and on the default prefix a running `pnpm dev` worker took
 * them and worked against the dev database.
 */
export const E2E_SCRIPTS_QUEUE_PREFIX = "nexaworks-e2e-scripts";

/** The queue prefix of the run in progress; each config sets it before global setup reads it. */
export const ACTIVE_PREFIX_ENV = "E2E_ACTIVE_QUEUE_PREFIX";
