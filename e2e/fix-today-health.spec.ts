import { expect, test, type Page } from "@playwright/test";
import { signIn } from "./support/app";
import { inWorkspace } from "./support/m4";

const WS = "larkspur-demo";

const renewalRows = (page: Page) => page.locator('[data-testid^="renewal-row-"]');
const todayRenewalsCount = async (page: Page) => {
  const heading = await page
    .getByRole("heading", { name: /Renewals in the next 90 days/ })
    .innerText();
  return Number(/\((\d+)\)/.exec(heading)![1]);
};

test.describe("FIX-2026-11-11 · Today vs Renewals, and unscored accounts", () => {
  test.beforeEach(({ page: _page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "flow runs on desktop only");
  });

  test("a CSM: Today's renewal list, its 30-day card and the Renewals page tell the same story", async ({
    page,
  }) => {
    await signIn(page, "leo@larkspur.test");
    await page.goto("/today");
    const todayCount = await todayRenewalsCount(page);
    const card30 = Number(
      (await page.getByRole("link", { name: /Renewals in 30 days/ }).innerText()).match(
        /\n(\d+)\n/,
      )?.[1],
    );
    await page.goto("/renewals?days=90");
    await expect(renewalRows(page).first()).toBeVisible();
    expect(await renewalRows(page).count()).toBe(todayCount);
    expect(todayCount).toBeGreaterThan(0);
    await page.goto("/renewals?days=30");
    await expect(page.getByRole("heading", { name: "Renewals", level: 1 })).toBeVisible();
    expect(await renewalRows(page).count()).toBe(card30);
  });

  test("Admin owns no accounts: Today says so and points at the Renewals page's own total", async ({
    page,
  }) => {
    await signIn(page, "admin@larkspur.test");
    await page.goto("/renewals?days=90");
    await expect(renewalRows(page).first()).toBeVisible();
    const all = await renewalRows(page).count();
    expect(all).toBeGreaterThan(0);
    await page.goto("/today");
    expect(await todayRenewalsCount(page)).toBe(0);
    await expect(page.getByTestId("today-RENEWAL")).toContainText(
      `None of your own accounts renew in the next 90 days. The Renewals page lists ${all} across everyone you can see.`,
    );
  });

  test("Health lists every unscored account with its reason; none is silently absent", async ({
    page,
  }) => {
    const lost = await inWorkspace(WS, (tx, ws) =>
      tx.account.count({ where: { workspaceId: ws, lifecycleStage: "LOST", archivedAt: null } }),
    );
    expect(lost).toBeGreaterThan(0);
    await signIn(page, "admin@larkspur.test");
    await page.goto("/health");
    const section = page.getByTestId("not-scored");
    await expect(section).toBeVisible();
    await expect(section.getByText(new RegExp(`Not scored \\(${lost}\\)`))).toBeVisible();
    const rows = section.getByTestId("not-scored-row");
    await expect(rows).toHaveCount(lost);
    await expect(rows.first()).toContainText("Health is only calculated for active customers");
  });

  test("a lost account reads 'Not scored (lost account)' on the Accounts list, not 'Not scored yet'", async ({
    page,
  }) => {
    await signIn(page, "admin@larkspur.test");
    await page.goto("/accounts?stage=LOST");
    await expect(page.getByText("Not scored (lost account)").first()).toBeVisible();
    await expect(page.getByText("Not scored yet")).toHaveCount(0);
  });
});
