import { expect, test } from "@playwright/test";
import { signIn } from "./support/app";

test.describe("AI cost session · Pilot metrics shows month-to-date AI usage as an estimate", () => {
  test.beforeEach(({ page: _page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "flow runs on desktop only");
  });

  test("Admin sees the month's token use against the budget and a labelled cost estimate", async ({
    page,
  }) => {
    await signIn(page, "admin@larkspur.test");
    await page.goto("/reports/pilot-metrics");
    const ai = page.getByTestId("ai-usage");
    await expect(ai).toBeVisible();
    await expect(ai.getByRole("heading", { name: "AI usage this month (estimate)" })).toBeVisible();
    await expect(ai).toContainText("tokens");
    await expect(ai).toContainText("of 10,000,000 tokens"); // the default monthly budget
    await expect(page.getByTestId("ai-cost-estimate")).toHaveText(/^\$\d+\.\d{2}$/);
    // Labelled as an estimate, never as an invoice.
    await expect(ai).toContainText("Estimate:");
    await expect(ai).toContainText("Not an invoice");
    // Unspent budget shows no alert.
    await expect(page.getByTestId("ai-budget-soft")).toHaveCount(0);
    await expect(page.getByTestId("ai-budget-paused")).toHaveCount(0);
  });
});
