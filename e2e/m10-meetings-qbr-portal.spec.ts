import { expect, test } from "@playwright/test";
import { signIn } from "./support/app";
import { inWorkspace } from "./support/m4";

const WS = "larkspur-demo";

test.describe("M10 Meetings, QBR, Success Plans, Portal & Surveys", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeEach(({ page: _page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "flow runs on desktop only");
  });

  test("Today shows Brightwell meeting at 14:00 with brief ready", async ({ page }) => {
    await inWorkspace(WS, async (tx, ws) => {
      await tx.todayItem.deleteMany({ where: { workspaceId: ws } });
    });
    await signIn(page, "leo@larkspur.test");
    await page.goto("/today");

    const meetingsSection = page.getByTestId("today-MEETING");
    await expect(meetingsSection).toBeVisible();
    await expect(meetingsSection.getByText(/Brightwell Logistics sync/i)).toBeVisible();
    await expect(meetingsSection.getByText(/brief ready/i)).toBeVisible();
  });

  test("New QBR generation page loads with locked metrics panel and period allowlist", async ({ page }) => {
    await signIn(page, "leo@larkspur.test");
    await page.goto("/meetings/qbr/new");

    await expect(page.getByRole("heading", { name: "Generate Executive Business Review (QBR)" })).toBeVisible();
    await expect(page.getByTestId("qbr-account-select")).toBeVisible();
    await expect(page.getByTestId("qbr-period-input")).toHaveValue("Q3 2026");
    await expect(page.getByTestId("locked-metrics-panel")).toBeVisible();
  });

  test("Account 360 Plans tab renders Brightwell success plan and goals", async ({ page }) => {
    await signIn(page, "leo@larkspur.test");

    const brightwell = await inWorkspace(WS, (tx, ws) =>
      tx.account.findFirstOrThrow({ where: { workspaceId: ws, name: "Brightwell Logistics" } }),
    );

    await page.goto(`/accounts/${brightwell.id}/plans`);
    await expect(page.getByTestId("account-plans")).toBeVisible();
    await expect(page.getByText("Q4 Value Delivery & Executive Alignment")).toBeVisible();
    await expect(page.getByTestId("portal-sharing-badge")).toContainText("Shared with customer portal");
    await expect(page.getByTestId("goals-list")).toBeVisible();
    await expect(page.getByText("Invite finance team to executive review")).toBeVisible();
  });

  test("Settings › Surveys shows active NPS survey and recent detractor response", async ({ page }) => {
    await signIn(page, "dana@larkspur.test");
    await page.goto("/settings/surveys");

    await expect(page.getByRole("heading", { name: "Customer Surveys" })).toBeVisible();
    await expect(page.getByText("NPS Survey")).toBeVisible();
    await expect(page.getByTestId("responses-list")).toBeVisible();
    await expect(page.getByText("Score: 4")).toBeVisible();
    await expect(page.getByText(/Product functionality is solid/i)).toBeVisible();
  });

  test("Portal route denies invalid token with an honest error state", async ({ page }) => {
    await page.goto("/portal/invalid-token-sequence-12345678901234567890");
    await expect(page.getByTestId("portal-auth-error")).toBeVisible();
    await expect(page.getByText(/invalid/i)).toBeVisible();
  });
});
