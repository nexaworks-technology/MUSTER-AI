import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { seedId } from "../prisma/seed/run";
import { signIn } from "./support/app";

/** No serious or critical axe violations on M1 screens, at 1280 px and 375 px (M1 #15). */
async function expectNoBlockingViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  const blocking = results.violations.filter((v) =>
    ["serious", "critical"].includes(v.impact ?? ""),
  );
  expect(blocking.map((v) => `${v.id}: ${v.help} (${v.nodes.length})`)).toEqual([]);
}

test("axe: sign in", async ({ page }) => {
  await page.goto("/sign-in");
  await expectNoBlockingViolations(page);
});

test("axe: home, settings › users, settings › workspace", async ({ page }) => {
  await signIn(page, "admin@larkspur.test");
  await expectNoBlockingViolations(page);
  await page.goto("/settings/users");
  await expectNoBlockingViolations(page);
  await page.goto("/settings/workspace");
  await expectNoBlockingViolations(page);
});

test("axe: invalid invitation link", async ({ page }) => {
  await page.goto(`/invite/${"x".repeat(43)}`);
  await expect(page.getByText("isn't valid")).toBeVisible();
  await expectNoBlockingViolations(page);
});

/** M2 #13: Accounts, every Account 360 tab, Import and Data quality, at 1280 px and 375 px. */
test("axe: accounts, Account 360 tabs, import, data quality", async ({ page }) => {
  await signIn(page, "admin@larkspur.test");
  await page.goto("/accounts");
  await expectNoBlockingViolations(page);
  const brightwell = `/accounts/${seedId("account:brightwell")}`;
  for (const tab of [
    "",
    "/people",
    "/usage",
    "/tickets",
    "/conversations",
    "/billing",
    "/tasks",
    "/notes",
    "/timeline",
  ]) {
    await page.goto(`${brightwell}${tab}`);
    await expectNoBlockingViolations(page);
  }
  await page.goto("/settings/import");
  await expectNoBlockingViolations(page);
  await page.goto("/settings/data-quality?preview=all");
  await expectNoBlockingViolations(page);
});
