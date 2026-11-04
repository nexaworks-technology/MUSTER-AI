import { expect, test } from "@playwright/test";
import { signIn } from "./support/app";
import { inWorkspace } from "./support/m4";
import { prepareM8 } from "./support/m8";

const WS = "larkspur-demo";

test.describe("M8 Plays Engine and Campaigns", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeEach(({ page: _page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "flow runs on desktop only");
  });

  test.beforeAll(async ({}, testInfo) => {
    if (testInfo.project.name !== "desktop") return;
    await prepareM8(WS);
  });

  test("navigation to /plays shows seeded plays and allows inspection", async ({ page }) => {
    await signIn(page, "dana@larkspur.test");

    // Check navigation item
    const navLink = page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Plays" });
    await expect(navLink).toBeVisible();
    await navLink.click();

    // Verify /plays page
    await expect(page).toHaveURL(/\/plays/);
    await expect(page.getByRole("heading", { name: "Plays", exact: true })).toBeVisible();

    // Verify seeded plays are rendered
    await expect(page.getByRole("link", { name: "Health Risk" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Champion Loss" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Payment Failed" })).toBeVisible();

    // Click into Health Risk
    await page.getByRole("link", { name: "Health Risk" }).click();
    await expect(page).toHaveURL(/\/plays\/[a-z0-9]+/);
    await expect(page.getByRole("heading", { name: "Health Risk" })).toBeVisible();

    // Verify play detail shows triggers, steps, and results link
    await expect(page.getByText("What This Play Does")).toBeVisible();
    await expect(page.getByText(/Trigger:/).first()).toBeVisible();
    const resultsLink = page.getByRole("link", { name: /View Results/i });
    await expect(resultsLink).toBeVisible();
    await resultsLink.click();

    // Verify /plays/[id]/results page
    await expect(page).toHaveURL(/\/plays\/[a-z0-9]+\/results/);
    await expect(page.getByRole("heading", { name: /Results/i })).toBeVisible();
    await expect(page.getByText(/Accounts Entered/i)).toBeVisible();
    await expect(page.getByText(/Protected ARR/i)).toBeVisible();
  });

  test("campaigns tab navigates to campaigns view and new campaign form", async ({ page }) => {
    await signIn(page, "dana@larkspur.test");
    await page.goto("/plays");

    // Click Campaigns tab
    const campaignsTab = page.getByRole("link", { name: "Campaigns" });
    await expect(campaignsTab).toBeVisible();
    await campaignsTab.click();

    // Verify /campaigns page
    await expect(page).toHaveURL(/\/campaigns/);
    await expect(page.getByRole("heading", { name: "Campaigns", exact: true })).toBeVisible();

    // Click New Campaign
    const newBtn = page.getByRole("link", { name: "New Campaign" });
    await expect(newBtn).toBeVisible();
    await newBtn.click();

    // Verify /campaigns/new page
    await expect(page).toHaveURL(/\/campaigns\/new/);
    await expect(page.getByRole("heading", { name: "New Email Campaign" })).toBeVisible();
    await expect(page.getByLabel("Campaign Name")).toBeVisible();
    await expect(page.getByLabel("Target Segment")).toBeVisible();
    await expect(page.getByLabel("Subject Line")).toBeVisible();
    await expect(page.getByLabel("Email Message Body")).toBeVisible();
  });
});
