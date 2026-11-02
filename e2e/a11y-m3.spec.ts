import { test } from "@playwright/test";
import { seedId } from "../prisma/seed/run";
import { signIn } from "./support/app";
import { expectNoBlockingViolations } from "./support/axe";

/**
 * M3 #15: /health, the Health and Signals tabs, /health/signals, Settings › Signals and › Health
 * model, at 1280 px and 375 px. A new file: the pre-M3 `a11y.spec.ts` is not edited (decision 3).
 */
test("axe: health, signals, health-model settings", async ({ page }) => {
  await signIn(page, "admin@larkspur.test");
  const brightwell = `/accounts/${seedId("account:brightwell")}`;
  for (const path of [
    "/health",
    `${brightwell}/health`,
    `${brightwell}/signals`,
    "/health/signals",
    "/settings/signals",
    "/settings/health-model",
  ]) {
    await page.goto(path);
    // Closed <details> hide reasons and evidence from axe; open them so every reason is checked.
    await page.evaluate(() => document.querySelectorAll("details").forEach((d) => (d.open = true)));
    await expectNoBlockingViolations(page);
  }
});
