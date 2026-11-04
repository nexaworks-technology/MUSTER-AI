import { test } from "@playwright/test";
import { signIn } from "./support/app";
import { expectNoBlockingViolations } from "./support/axe";
import { inWorkspace } from "./support/m4";
import { prepareM7 } from "./support/m7";

/**
 * M7 acceptance #15: axe (WCAG 2.1 AA, no serious or critical violations) on /renewals (with a
 * "Why" drill-down open), a Renewal brief (with the Renewal Manager's plan on it), /expansion (with
 * the Finder's note, the whitespace panel and the update form open), an account's Expansion and
 * Renewal tabs, and /revenue, at 1280 px and 375 px. A new file: earlier a11y specs are not edited.
 */
const WS = "larkspur-demo";

test.beforeAll(async ({}, testInfo) => {
  if (testInfo.project.name !== "desktop") return;
  prepareM7(WS, "e2e-a11y");
});

test("axe: renewals, brief, expansion, account tabs, revenue", async ({ page }) => {
  await signIn(page, "dana@larkspur.test");
  const north = await inWorkspace(WS, (tx) =>
    tx.account.findFirstOrThrow({ where: { name: "Northgate Freight" } }),
  );
  const copper = await inWorkspace(WS, (tx) =>
    tx.account.findFirstOrThrow({ where: { name: "Copperleaf Studios" } }),
  );
  const renewal = await inWorkspace(WS, (tx) =>
    tx.renewal.findFirstOrThrow({
      where: { accountId: north.id, stage: { in: ["UPCOMING", "IN_PROGRESS"] } },
    }),
  );
  const pages = [
    "/renewals",
    `/renewals/${renewal.id}/brief`,
    "/expansion",
    `/accounts/${copper.id}/expansion`,
    `/accounts/${north.id}/renewal`,
    "/revenue",
  ];
  for (const p of pages) {
    await page.goto(p);
    for (const d of await page.locator("details").all())
      await d.evaluate((el) => el.setAttribute("open", ""));
    await expectNoBlockingViolations(page);
  }
});
