import { expect, test } from "@playwright/test";
import { signIn } from "./support/app";

/**
 * M7 demo script, Session A part (docs/milestones/M7.md), against the seeded `_test` database
 * frozen at SEED_TODAY (2026-11-02). Per D-120 (corrected): Northgate Freight is one of seven
 * renewals tied at the lowest confidence (70%) in the next 90 days. The test asserts that tie
 * group and Northgate's membership and reasons, and nothing stronger; the LOW-band story arrives
 * with M9/M10 data. Session B adds the expansion, brief and outcome steps.
 */
const TIE = [
  "Aspenwood Fitness",
  "Harborbrook Solicitors",
  "Meridianhaven Consulting",
  "Larkwood Works",
  "Northgate Freight",
  "Harborwood Accounting",
  "Beaconcrest Transport",
];

test.describe("M7 renewals and revenue", () => {
  test.describe.configure({ mode: "serial" });
  test.beforeEach(({ page: _page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "flow runs on desktop only");
  });

  test("Dana's radar: the seven-way tie at 70%, Northgate among them, with its reasons and ARR", async ({
    page,
  }) => {
    await signIn(page, "dana@larkspur.test");
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Renewals" })
      .click();
    await expect(page.getByRole("heading", { name: "Renewals", exact: true })).toBeVisible();
    await expect(page.getByTestId("forecast")).toBeVisible();
    for (const name of TIE)
      await expect(page.getByTestId(`renewal-row-${name}`).getByTestId("confidence")).toHaveText(
        "70%",
      );
    const northgate = page.getByTestId("renewal-row-Northgate Freight");
    await expect(northgate).toContainText("Dec 13, 2026");
    await expect(northgate).toContainText("$142,000");
    await northgate.locator("summary", { hasText: "Why 70%" }).click();
    await expect(northgate).toContainText("Health (+10 points): Health is Healthy");
    await expect(northgate).toContainText("Notice deadline (-10 points)");
    // Nothing else is listed lower than the tie.
    const all = await page.getByTestId("confidence").allTextContents();
    expect(Math.min(...all.map((t) => Number(t.replace("%", ""))))).toBe(70);
  });

  test("A person's forecast category sits beside the computed band; a difference is flagged; clearing it works", async ({
    page,
  }) => {
    await signIn(page, "dana@larkspur.test");
    await page.goto("/renewals");
    const row = page.getByTestId("renewal-row-Northgate Freight");
    await row.locator("summary", { hasText: "Change" }).click();
    await row.getByLabel("Forecast category").selectOption("AT_RISK");
    await row.getByLabel("Note").fill("Champion wavering");
    await row.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("status")).toContainText("Forecast category saved.");
    const after = page.getByTestId("renewal-row-Northgate Freight");
    await expect(after.getByTestId("forecast-disagreement")).toContainText("suggests Commit");
    await expect(after.getByTestId("confidence")).toHaveText("70%");
    await after.locator("summary", { hasText: "Change" }).click();
    await after.getByLabel("Forecast category").selectOption("");
    await after.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("status")).toContainText("Forecast category cleared.");
  });

  test("Leo (no revenue access): the radar shows no money and no forecast, Revenue is not in the nav and is a 404", async ({
    page,
  }) => {
    await signIn(page, "leo@larkspur.test");
    await page.goto("/renewals");
    await expect(page.getByRole("heading", { name: "Renewals", exact: true })).toBeVisible();
    await expect(page.getByTestId("forecast")).toHaveCount(0);
    await expect(page.locator("tbody tr").first()).toContainText("Restricted");
    await expect(
      page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Revenue" }),
    ).toHaveCount(0);
    const res = await page.goto("/revenue");
    expect(res?.status()).toBe(404);
  });

  test("Dana's Revenue screen: a reconciled waterfall, money at risk, expected billing, coverage and team load", async ({
    page,
  }) => {
    await signIn(page, "dana@larkspur.test");
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Revenue" })
      .click();
    await expect(page.getByRole("heading", { name: "Revenue", exact: true })).toBeVisible();
    const wf = page.getByTestId("waterfall-USD");
    await expect(wf).toContainText("Opening ARR");
    await expect(wf).toContainText("Closing ARR");
    await expect(wf).toContainText("Opening plus movements equals closing");
    await expect(page.getByTestId("at-risk-30")).toBeVisible();
    await expect(page.getByTestId("at-risk-90")).toBeVisible();
    await expect(page.getByTestId("coverage")).toContainText(
      "accounts had contact in the last 30 days",
    );
    await expect(page.getByRole("heading", { name: "Team load" })).toBeVisible();
  });
});
