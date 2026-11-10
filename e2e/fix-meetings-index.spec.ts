import { expect, test, type Page } from "@playwright/test";
import { signIn } from "./support/app";
import { expectNoBlockingViolations } from "./support/axe";
import { inWorkspace } from "./support/m4";

const WS = "larkspur-demo";
const SYNC = /Brightwell Logistics sync/;

const sidebarLink = (page: Page) =>
  page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Meetings & QBRs" });

test.describe("FIX-2026-11-11 · Meetings & QBRs index", () => {
  test.beforeEach(({ page: _page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "flow runs on desktop only");
  });

  for (const [who, email] of [
    ["Admin", "admin@larkspur.test"],
    ["CS Leader", "dana@larkspur.test"],
    ["CSM (owns Brightwell)", "leo@larkspur.test"],
  ] as const) {
    test(`${who}: the sidebar link opens /meetings, which lists meetings and QBRs and links to QBR creation`, async ({
      page,
    }) => {
      await signIn(page, email);
      await sidebarLink(page).click();
      await expect(page).toHaveURL(/\/meetings$/);
      await expect(page.getByRole("heading", { level: 1, name: "Meetings & QBRs" })).toBeVisible();
      await expect(page.getByRole("heading", { name: /Upcoming meetings/ })).toBeVisible();
      await expect(page.getByRole("heading", { name: /Past meetings/ })).toBeVisible();
      await expect(page.getByRole("heading", { name: /Business reviews \(QBRs\)/ })).toBeVisible();
      await expect(page.getByTestId("meetings-index").getByText(SYNC)).toBeVisible();
      await page.getByRole("link", { name: "Generate a QBR" }).click();
      await expect(page).toHaveURL(/\/meetings\/qbr\/new$/);
      await expect(page.getByTestId("new-qbr-page")).toBeVisible();
    });
  }

  test("a CSM sees only their own book: Aisha does not see Leo's Brightwell meeting", async ({
    page,
  }) => {
    await signIn(page, "aisha@larkspur.test");
    await page.goto("/meetings");
    await expect(page.getByTestId("meetings-page")).toBeVisible();
    await expect(page.getByText(SYNC)).toHaveCount(0);
  });

  test("a Viewer can read the index but is offered no way to generate a QBR", async ({ page }) => {
    await signIn(page, "tom@larkspur.test");
    await page.goto("/meetings");
    await expect(page.getByRole("heading", { level: 1, name: "Meetings & QBRs" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Generate a QBR" })).toHaveCount(0);
  });

  test("the sidebar link is on every screen, not only some", async ({ page }) => {
    await signIn(page, "admin@larkspur.test");
    const accountId = await inWorkspace(WS, async (tx, ws) => {
      const a = await tx.account.findFirstOrThrow({
        where: { workspaceId: ws, name: "Brightwell Logistics" },
      });
      return a.id;
    });
    for (const path of [
      "/today",
      "/",
      "/accounts",
      `/accounts/${accountId}`,
      `/accounts/${accountId}/health`,
      "/health",
      "/tasks",
      "/approvals",
      "/renewals",
      "/expansion",
      "/plays",
      "/inbox",
      "/promises",
      "/reports",
      "/ask",
      "/meetings",
      "/meetings/qbr/new",
      "/settings",
    ]) {
      await page.goto(path);
      await expect(sidebarLink(page), `sidebar link missing on ${path}`).toBeVisible();
    }
  });

  test("Account 360 has a Meetings tab that lists that account's meetings", async ({ page }) => {
    await signIn(page, "leo@larkspur.test");
    const accountId = await inWorkspace(WS, async (tx, ws) => {
      const a = await tx.account.findFirstOrThrow({
        where: { workspaceId: ws, name: "Brightwell Logistics" },
      });
      return a.id;
    });
    await page.goto(`/accounts/${accountId}`);
    await page
      .getByRole("navigation", { name: "Account sections" })
      .getByRole("link", { name: "Meetings" })
      .click();
    await expect(page).toHaveURL(new RegExp(`/accounts/${accountId}/meetings$`));
    await expect(page.getByTestId("meetings-index").getByText(SYNC)).toBeVisible();
  });

  test("the index has no blocking accessibility violations", async ({ page }) => {
    await signIn(page, "admin@larkspur.test");
    await page.goto("/meetings");
    await expect(page.getByTestId("meetings-page")).toBeVisible();
    await expectNoBlockingViolations(page);
  });
});
