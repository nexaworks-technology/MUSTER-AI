import { test } from "@playwright/test";
import { seedId } from "../prisma/seed/run";
import { signIn } from "./support/app";
import { expectNoBlockingViolations } from "./support/axe";
import { prepareM6 } from "./support/m6";

/**
 * M6 acceptance #14: axe (WCAG 2.1 AA, no serious or critical violations) on /onboarding, an
 * account's Onboarding tab, its Adoption tab (with the Adoption Coach's finding on it) and
 * Settings › Onboarding templates, at 1280 px and 375 px. A new file: earlier a11y specs are not
 * edited. Settings › Integrations (with the Usage API, Mixpanel and Amplitude cards) is covered by
 * `a11y-m5.spec.ts`, which already opens every card.
 */
test.beforeAll(async ({}, testInfo) => {
  if (testInfo.project.name !== "desktop") return;
  prepareM6("larkspur-demo", "e2e-a11y");
});

test("axe: onboarding list, onboarding tab, adoption tab, templates", async ({ page }) => {
  await signIn(page, "admin@larkspur.test");
  const pinecrest = `/accounts/${seedId("account:pinecrest")}`;
  const pages = [
    "/onboarding",
    `${pinecrest}/onboarding`,
    `${pinecrest}/adoption`,
    "/settings/onboarding-templates",
    "/settings/integrations",
  ];
  for (const p of pages) {
    await page.goto(p);
    for (const d of await page.locator("details").all())
      await d.evaluate((el) => el.setAttribute("open", ""));
    await expectNoBlockingViolations(page);
  }
});
