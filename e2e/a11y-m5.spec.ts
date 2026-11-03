import { test } from "@playwright/test";
import { signIn } from "./support/app";
import { expectNoBlockingViolations } from "./support/axe";

/**
 * M5 acceptance #15: axe (WCAG 2.1 AA, no serious or critical violations) on Settings ›
 * Integrations, Settings › Data health and every /setup step, at 1280 px and 375 px. A new file:
 * pre-M5 a11y specs are not edited. Larkspur is live, so /setup shows its revisit state.
 */
test("axe: integrations, data health, setup steps", async ({ page }) => {
  await signIn(page, "admin@larkspur.test");
  const pages = [
    "/settings/integrations",
    "/settings/data-health",
    "/setup?step=connect",
    "/setup?step=import",
    "/setup?step=tiers",
    "/setup?step=health",
    "/setup?step=live",
  ];
  for (const p of pages) {
    await page.goto(p);
    for (const d of await page.locator("details").all())
      await d.evaluate((el) => el.setAttribute("open", ""));
    await expectNoBlockingViolations(page);
  }
});
