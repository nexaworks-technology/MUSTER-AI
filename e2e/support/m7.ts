import { runScript } from "./m4";

/**
 * M7 e2e support. As in M4 and M6, the app under test has no AI key, so the two M7 agents run here,
 * before the browser steps, through the real executor on the RECORDED transport
 * (scripts/recorded-renewals.ts: fixture answers composed from the records; no live model). The app
 * then shows what those runs stored, exactly as it would show live runs. The script runs on the same
 * frozen clock as the app (SEED_TODAY), so a next-step date is the same day the page shows.
 */
const E2E_CLOCK = { ALLOW_FAKE_CLOCK: "true", APP_FAKE_NOW: "2026-11-02T17:00:00Z" };

export function prepareM7(workspace: string, nonce: string): string {
  return runScript("scripts/recorded-renewals.ts", ["--workspace", workspace, "--nonce", nonce], {
    AI_PROVIDER: "recorded",
    AI_RECORDINGS_DIR: ".dev-recordings/e2e",
    ...E2E_CLOCK,
  });
}

/**
 * Records a renewal outcome through the real path (a successor contract record, then renewals.sync
 * and the revenue checkpoint as of the day after the renewal): scripts/demo-renewal-outcome.ts.
 */
export function recordRenewalOutcome(workspace: string, account: string): string {
  return runScript(
    "scripts/demo-renewal-outcome.ts",
    ["--workspace", workspace, "--account", account],
    E2E_CLOCK,
  );
}
